import type { SshTarget } from '../../../shared/ssh-types'
import { getSystemSshBuildArgsFromOperationOptions } from './system-ssh-args'
import { spawnSystemSshCommand } from './system-ssh-command'
import {
  awaitWithSystemSshAbort,
  SystemSshCommandExitError,
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

/** Damage bound only: 32KiB still hung 15/120 under load on Windows 11/OpenSSH 10.0p2. The defect is per read; smaller chunks add risky execs rather than guarantee safety. */
export const WINDOWS_STDIN_WRITE_CHUNK_BYTES = 32 * 1024

type WindowsWriteOptions = Parameters<typeof getSystemSshBuildArgsFromOperationOptions>[0] & {
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

/** Prefer SFTP (no remote stdin), then PowerShell 7, then bounded unreliable 5.1. On Windows 11/OpenSSH 10.0p2, SFTP sent 1.9MB in median 315ms while chunked 5.1 completed 0/6. Stage uniquely before publish so retries avoid predecessor locks. */
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

/** All transports share unique staging and best-effort cleanup of unused uploads after failed publish. */
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
    // No bytes moved on refusal; avoid a pointless cleanup round trip.
    if (!nothingStaged(error)) {
      await discardStagedWrite(target, stagingPath, options)
    }
    throw error
  }
}

/** Path refusal falls back for this write only; a host-wide cache verdict would degrade unrelated later paths. */
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

/** PowerShell 7 accepts the whole payload; chunk only unreliable 5.1 to bound damage, never as a safety guarantee. */
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

/** Expose the host-side cause/remedy so users do not retry a network that cannot fix 5.1 stdin. */
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
  if (!(error instanceof SystemSshCommandExitError)) {
    return false
  }
  // A complete missing-pwsh diagnostic establishes absence; paths and mixed errors do not.
  const stderr = error.stderr.trim()
  return (
    error.exitCode === 9009 ||
    /^'pwsh\.exe' is not recognized as an internal or external command(?:,\r?\noperable program or batch file\.)?$/i.test(
      stderr
    ) ||
    /^CommandNotFoundException:[ \t]*pwsh\.exe$/i.test(stderr) ||
    isPowerShellMissingPwshDiagnostic(stderr)
  )
}

function isPowerShellMissingPwshDiagnostic(stderr: string): boolean {
  // NormalView wraps physical lines; its localized prose and category template are not identifiers.
  const record = stderr.replace(/\r?\n/g, '')
  const sections =
    /^pwsh\.exe[ \t]*:[ \t]*([^+]+)\+[ \t]*pwsh\.exe([ \t]+-[^~]*?)\+[ \t]*~{8}[ \t]*\+[ \t]*CategoryInfo[ \t]*:[ \t]*([^+]+)\+[ \t]*FullyQualifiedErrorId[ \t]*:[ \t]*CommandNotFoundException[ \t]*$/.exec(
      record
    )
  if (!sections) {
    return false
  }
  const prelude = sections[1] ?? ''
  const source = sections[2] ?? ''
  const category = sections[3] ?? ''
  return (
    !/\b[\w.-]+\.exe[ \t]*:/.test(prelude) &&
    /^[ \t]+-NoProfile[ \t]+-NonInteractive[ \t]+-(?:Command[ \t]+exit|EncodedCommand[ \t]+[A-Za-z0-9+/=]+(?:[ \t]*\.{3})?)[ \t]*$/.test(
      source
    ) &&
    category.match(/(?<![\w./\\-])pwsh\.exe(?![\w./\\-])/g)?.length === 1 &&
    category.match(/\bString\b/g)?.length === 1 &&
    category.match(/\bCommandNotFoundException\b/g)?.length === 1
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
    // Unique names make cleanup failure harmless; it proves nothing about abandoned-writer liveness.
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
