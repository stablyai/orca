import type { SshTarget } from '../../shared/ssh-types'
import { getSystemSshBuildArgsFromOperationOptions } from './system-ssh-args'
import { spawnSystemSshCommand } from './system-ssh-command'
import {
  awaitWithSystemSshAbort,
  throwIfAborted,
  waitForChannelClose
} from './system-ssh-operation-lifecycle'
import {
  isSftpPathUnsupportedError,
  isSftpRefusalBeforeStaging,
  isSftpUnavailableError,
  runSftpBatch
} from './system-ssh-sftp-transfer'
import { quoteSftpBatchArgument, toSftpRemotePath } from './system-ssh-sftp-path'
import { getWindowsRemoteWriteCapabilities } from './system-ssh-windows-write-capabilities'
import {
  makeWindowsDiscardStagedFileCommand,
  makeWindowsPublishStagedFileCommand,
  makeWindowsStagingPath,
  makeWindowsWriteFileCommand,
  windowsRemoteAncestorDirectories,
  type WindowsPublishMode
} from './system-ssh-windows-file-write'

/** No Windows stdin write should ever outlive this; a wedged PowerShell never closes on its own. */
export const WINDOWS_STDIN_WRITE_TIMEOUT_MS = 60_000

/**
 * Bound on one stdin write for the last-resort Windows PowerShell 5.1 path.
 *
 * Measured on Windows 11 26200 / OpenSSH 10.0p2: a 32KB write still hangs 15 times in 120 under
 * load, and no smaller value removes the risk. The defect is per blocking read, not per byte, so
 * shrinking the chunk trades one risky read for more execs that each carry their own. This is a
 * damage bound on a path known to be unreliable, not a safe size.
 */
export const WINDOWS_STDIN_WRITE_CHUNK_BYTES = 32 * 1024

export type WindowsWriteOptions = Parameters<
  typeof getSystemSshBuildArgsFromOperationOptions
>[0] & {
  signal?: AbortSignal
  append?: boolean
  exclusive?: boolean
}

/** Bytes to write, plus a way to present them to sftp, which can only send a local file. */
export type WindowsWriteSource = {
  totalBytes: number
  readChunk: (offset: number, maxBytes: number) => Promise<Buffer>
  withLocalFile: <T>(send: (localPath: string) => Promise<T>) => Promise<T>
}

function publishMode(options: WindowsWriteOptions): WindowsPublishMode {
  return options.append ? 'append' : options.exclusive === true ? 'exclusive' : 'create'
}

/**
 * Writes one file to a Windows host, preferring transports that do not push bytes through a remote
 * PowerShell's stdin.
 *
 * Order, and why: sftp carries the whole payload in one transfer and never has a remote process
 * read a pipe. Measured on Windows 11 / OpenSSH 10.0p2: 1.9MB in a median 315ms over sftp against
 * 0 of 6 completions on the chunked path, whose best case was ~62 execs at ~350ms each. PowerShell
 * 7 reads a redirected stdin correctly but is not installed by default. Windows PowerShell 5.1 is
 * always present and is the defective reader, so it is last and it is bounded.
 *
 * Every transport stages under a unique name and publishes by rename, so no partial write is ever
 * visible under the real name and no retry inherits a predecessor's lock.
 */
export async function writeWindowsRemoteFile(
  target: SshTarget,
  remotePath: string,
  source: WindowsWriteSource,
  options: WindowsWriteOptions
): Promise<void> {
  throwIfAborted(options.signal)
  const capabilities = getWindowsRemoteWriteCapabilities(target)
  await capabilities.runWithFallback(
    'sftp-subsystem',
    () => writeViaSftp(target, remotePath, source, options),
    () => writeViaRemoteStdin(target, remotePath, source, options),
    isSftpUnavailableError
  )
}

/**
 * Stages under a name nothing else can own, publishes it, and sweeps the staging file if either
 * step fails.
 *
 * Shared by both transports so the cleanup contract cannot drift between them: a failed publish —
 * an exclusive conflict is the ordinary case — leaves bytes on the host that no longer have a
 * purpose, and the sweep is what stops them accumulating.
 */
async function stageThenPublish(
  target: SshTarget,
  remotePath: string,
  options: WindowsWriteOptions,
  stage: (stagingPath: string) => Promise<void>,
  nothingStaged: (error: unknown) => boolean = () => false
): Promise<void> {
  const stagingPath = makeWindowsStagingPath(remotePath)
  try {
    await stage(stagingPath)
    await publishStagedWrite(target, stagingPath, remotePath, options)
  } catch (error) {
    // A transport that declined before it moved any bytes has nothing to sweep, and sweeping
    // anyway would spend a round trip on every write to a host that has no sftp subsystem.
    if (!nothingStaged(error)) {
      await discardStagedWrite(target, stagingPath, options)
    }
    throw error
  }
}

/**
 * A path sftp cannot address falls back for this write alone, without touching the host verdict.
 *
 * The distinction matters because the capability cache is keyed by host and holds for half an hour:
 * routing one UNC destination, or one local filename containing a newline, into
 * `rememberUnsupported` would send every later write to that host down the defective path too.
 */
async function writeViaSftp(
  target: SshTarget,
  remotePath: string,
  source: WindowsWriteSource,
  options: WindowsWriteOptions
): Promise<void> {
  try {
    await attemptSftpWrite(target, remotePath, source, options)
  } catch (error) {
    if (!isSftpPathUnsupportedError(error)) {
      throw error
    }
    await writeViaRemoteStdin(target, remotePath, source, options)
  }
}

function attemptSftpWrite(
  target: SshTarget,
  remotePath: string,
  source: WindowsWriteSource,
  options: WindowsWriteOptions
): Promise<void> {
  const mkdirs = windowsRemoteAncestorDirectories(remotePath).map(
    (directory) => `-mkdir ${quoteSftpBatchArgument(toSftpRemotePath(directory))}`
  )
  return stageThenPublish(
    target,
    remotePath,
    options,
    (stagingPath) =>
      source.withLocalFile((localPath) =>
        // One round trip: the parent chain and the payload travel in the same batch.
        runSftpBatch(
          target,
          [
            ...mkdirs,
            `put ${quoteSftpBatchArgument(localPath)} ${quoteSftpBatchArgument(toSftpRemotePath(stagingPath))}`
          ],
          options
        )
      ),
    isSftpRefusalBeforeStaging
  )
}

function writeViaRemoteStdin(
  target: SshTarget,
  remotePath: string,
  source: WindowsWriteSource,
  options: WindowsWriteOptions
): Promise<void> {
  const capabilities = getWindowsRemoteWriteCapabilities(target)
  return stageThenPublish(target, remotePath, options, (stagingPath) =>
    capabilities.runWithFallback(
      'pwsh',
      () => writeStdinChunks(target, stagingPath, source, options, 'pwsh.exe'),
      () => writeStdinChunks(target, stagingPath, source, options, 'powershell.exe'),
      isPwshUnavailableError
    )
  )
}

/**
 * PowerShell 7 takes the whole payload in one exec — measured at 2MB — so only the 5.1 path pays
 * for chunking, and only because a bounded write is the most that path can be trusted with.
 */
async function writeStdinChunks(
  target: SshTarget,
  stagingPath: string,
  source: WindowsWriteSource,
  options: WindowsWriteOptions,
  executable: 'powershell.exe' | 'pwsh.exe'
): Promise<void> {
  const chunkBytes =
    executable === 'pwsh.exe' ? Math.max(source.totalBytes, 1) : WINDOWS_STDIN_WRITE_CHUNK_BYTES
  let offset = 0
  // An empty write still has to run: it is what creates the staged file.
  do {
    const chunk = await source.readChunk(offset, chunkBytes)
    if (chunk.length === 0 && offset < source.totalBytes) {
      throw new Error(`Source ran short during upload of ${stagingPath}`)
    }
    await writeOneStdinChunk(
      target,
      stagingPath,
      chunk,
      { ...options, append: offset > 0, exclusive: false },
      offset,
      executable
    )
    offset += chunk.length
  } while (offset < source.totalBytes)
}

async function writeOneStdinChunk(
  target: SshTarget,
  stagingPath: string,
  chunk: Buffer,
  options: WindowsWriteOptions,
  offset: number,
  executable: 'powershell.exe' | 'pwsh.exe'
): Promise<void> {
  throwIfAborted(options.signal)
  const channel = spawnSystemSshCommand(
    target,
    makeWindowsWriteFileCommand(stagingPath, {
      append: options.append,
      exclusive: options.exclusive,
      executable
    }),
    { wrapCommand: false, ...getSystemSshBuildArgsFromOperationOptions(options) }
  )
  const closePromise = awaitWithSystemSshAbort(
    options.signal,
    () => channel.close(),
    waitForChannelClose(
      channel,
      `write ${stagingPath} at offset ${offset}`,
      WINDOWS_STDIN_WRITE_TIMEOUT_MS
    )
  ).catch((error: unknown) => {
    throw executable === 'powershell.exe' ? explainWindowsPowerShellStdinFailure(error) : error
  })
  if (!options.signal?.aborted) {
    channel.stdin.end(chunk)
  }
  await closePromise
}

/**
 * Names the cause on the one path that can hang, so the failure is not just "timed out".
 *
 * A user seeing this needs to know it is a host limitation with a host-side remedy, not a network
 * fault they should retry into.
 */
export function explainWindowsPowerShellStdinFailure(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error)
  if (!/timed out/i.test(message)) {
    return error
  }
  return new Error(
    `${message}\nWindows PowerShell 5.1 can lose a redirected stdin permanently when a read finds it momentarily empty, so this write cannot be made reliable from the client. Enable the sftp subsystem on the host (sshd_config: "Subsystem sftp sftp-server.exe"), or install PowerShell 7, and Orca will use it automatically.`,
    { cause: error instanceof Error ? error : undefined }
  )
}

function isPwshUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  // cmd.exe's "not recognized" and sshd's exit 9009 both mean "no pwsh here". A timeout does not:
  // that is the stdin defect, and PowerShell 7 does not have it, so it must not be cached as absent.
  return /is not recognized as an internal or external command|9009|CommandNotFoundException/i.test(
    message
  )
}

async function publishStagedWrite(
  target: SshTarget,
  stagingPath: string,
  remotePath: string,
  options: WindowsWriteOptions
): Promise<void> {
  await runWindowsCommandWithoutStdin(
    target,
    makeWindowsPublishStagedFileCommand(stagingPath, remotePath, publishMode(options)),
    `publish ${remotePath}`,
    options
  )
}

async function discardStagedWrite(
  target: SshTarget,
  stagingPath: string,
  options: WindowsWriteOptions
): Promise<void> {
  try {
    await runWindowsCommandWithoutStdin(
      target,
      makeWindowsDiscardStagedFileCommand(stagingPath),
      `discard ${stagingPath}`,
      { ...options, signal: undefined }
    )
  } catch {
    // Housekeeping only. The staging name is unique, so a leftover blocks nothing, and a failure
    // here says nothing about whether the abandoned writer is still alive.
  }
}

function runWindowsCommandWithoutStdin(
  target: SshTarget,
  command: string,
  label: string,
  options: WindowsWriteOptions
): Promise<void> {
  const channel = spawnSystemSshCommand(target, command, {
    wrapCommand: false,
    ...getSystemSshBuildArgsFromOperationOptions(options)
  })
  const closePromise = awaitWithSystemSshAbort(
    options.signal,
    () => channel.close(),
    waitForChannelClose(channel, label, WINDOWS_STDIN_WRITE_TIMEOUT_MS)
  )
  if (!options.signal?.aborted) {
    channel.stdin.end()
  }
  return closePromise
}
