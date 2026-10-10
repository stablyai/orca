import { DirectoryTransferBudget } from './ssh-directory-transfer-budget'
import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, opendir } from 'node:fs/promises'
import { join as pathJoin } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { SshTarget } from '../../shared/ssh-types'
import { shellEscape, wrapRemoteCommandForPosixShell } from './ssh-connection-utils'
import { findSystemSsh } from './system-ssh-binary'
import {
  buildSshArgs,
  getSystemSshBuildArgsFromOperationOptions,
  type SystemSshBuildArgsOptions
} from './system-ssh-args'
import { spawnSystemSshCommand } from './system-ssh-command'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand } from './ssh-remote-powershell'
import {
  awaitWithSystemSshAbort,
  killProcess,
  throwIfAborted,
  waitForChannelClose,
  waitForProcess,
  isHostAnsweredSystemSshExit,
  type ProcessResult
} from './system-ssh-operation-lifecycle'
import {
  uploadFileViaSystemSsh,
  WINDOWS_STDIN_WRITE_CHUNK_BYTES,
  WINDOWS_STDIN_WRITE_TIMEOUT_MS,
  writeBufferViaSystemSsh
} from './system-ssh-file-binary-transfer'
import {
  isSftpPathUnsupportedError,
  isSftpUnavailableError,
  makeDirectoriesViaSftp
} from './system-ssh-sftp-transfer'
import { getWindowsRemoteWriteCapabilities } from './system-ssh-windows-write-capabilities'

type SystemSshOperationOptions = SystemSshBuildArgsOptions & {
  signal?: AbortSignal
  hostPlatform?: RemoteHostPlatform
}

export async function uploadDirectoryViaSystemSsh(
  target: SshTarget,
  localDir: string,
  remoteDir: string,
  options?: SystemSshOperationOptions
): Promise<void> {
  throwIfAborted(options?.signal)
  if (options?.hostPlatform && isWindowsRemoteHost(options.hostPlatform)) {
    await uploadDirectoryViaSystemSshWindows(target, localDir, remoteDir, options)
    return
  }

  const sshPath = findSystemSsh()
  if (!sshPath) {
    throw new Error('No system ssh binary found. Install OpenSSH to use system SSH transport.')
  }

  const tarCreate = spawn('tar', ['-czf', '-', '-C', localDir, '.'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const remoteCommand = `mkdir -p ${shellEscape(remoteDir)} && tar -xzf - -C ${shellEscape(remoteDir)}`
  const sshExtract = spawn(
    sshPath,
    [...buildSshArgs(target, options), wrapRemoteCommandForPosixShell(remoteCommand)],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }
  )

  let tarResult: ProcessResult | null = null
  let sshResult: ProcessResult | null = null
  try {
    ;[tarResult, sshResult] = await awaitWithSystemSshAbort(
      options?.signal,
      () => {
        killProcess(tarCreate)
        killProcess(sshExtract)
      },
      settleUploadPipeline(
        tarCreate,
        waitForProcess(tarCreate, 'local tar relay upload'),
        waitForProcess(sshExtract, 'system ssh relay upload', 'remote'),
        pipeline(tarCreate.stdout!, sshExtract.stdin!)
      )
    )
  } catch (err) {
    killProcess(tarCreate)
    killProcess(sshExtract)
    throw err
  }

  if (tarResult?.stderr.trim()) {
    console.warn(`[ssh-system] ${tarResult.label} stderr: ${tarResult.stderr.trim()}`)
  }
  if (sshResult?.stderr.trim()) {
    console.warn(`[ssh-system] ${sshResult.label} stderr: ${sshResult.stderr.trim()}`)
  }
}

/** What local tar says when its output, not its input, failed: the far end went away. */
const DOWNSTREAM_WRITE_FAILURE = /write error|cannot write|broken pipe|EPIPE/i

/**
 * Waits for all three, then names the cause; a failed ssh wins over a tar that succeeded. A remote
 * exit the host answered wins over a local tar failure that only followed it: tar was signalled,
 * failed after ssh closed, or reported a write/pipe error (BSD tar exits 1 with "Write error", no
 * signal). A local tar that failed on its own input first (missing directory, unreadable file) is
 * the client's fault.
 */
async function settleUploadPipeline(
  tarProcess: ChildProcess,
  local: Promise<ProcessResult>,
  remote: Promise<ProcessResult>,
  pipe: Promise<void>
): Promise<readonly [ProcessResult, ProcessResult]> {
  let settled = 0
  let localAt = 0
  let remoteAt = 0
  const stamp = <T>(promise: Promise<T>, record: (at: number) => void): Promise<T> =>
    promise.finally(() => record(++settled))
  const [tar, ssh, piped] = await Promise.allSettled([
    stamp(local, (at) => (localAt = at)),
    stamp(remote, (at) => (remoteAt = at)),
    pipe
  ])
  const remoteAnswered = ssh.status === 'rejected' && isHostAnsweredSystemSshExit(ssh.reason)
  if (tar.status === 'rejected') {
    const localFollowedRemote =
      tarProcess.signalCode !== null ||
      remoteAt < localAt ||
      (tar.reason instanceof Error && DOWNSTREAM_WRITE_FAILURE.test(tar.reason.message))
    throw remoteAnswered && localFollowedRemote ? ssh.reason : tar.reason
  }
  if (ssh.status === 'rejected') {
    throw ssh.reason
  }
  if (piped.status === 'rejected') {
    throw piped.reason
  }
  return [tar.value, ssh.value]
}

export async function writeFileViaSystemSsh(
  target: SshTarget,
  remotePath: string,
  contents: string,
  options?: SystemSshOperationOptions
): Promise<void> {
  throwIfAborted(options?.signal)
  await writeBufferViaSystemSsh(target, remotePath, Buffer.from(contents, 'utf-8'), options)
}

async function uploadDirectoryViaSystemSshWindows(
  target: SshTarget,
  localDir: string,
  remoteDir: string,
  options: SystemSshOperationOptions
): Promise<void> {
  const hostPlatform = options.hostPlatform
  if (!hostPlatform) {
    throw new Error('Windows system SSH upload requires a remote host platform')
  }
  const plan = await collectLocalUploadPlan(localDir, remoteDir, hostPlatform, options.signal)
  await createWindowsUploadDirectories(target, plan.directories, options)
  for (const file of plan.files) {
    throwIfAborted(options.signal)
    // Reuses the single-file upload: it already opens O_NOFOLLOW, verifies the source did not
    // change under it, and splits the bytes into stdin-sized writes staged under a partial name.
    await uploadFileViaSystemSsh(target, file.localPath, file.remotePath, options)
  }
}

export type LocalUploadPlan = {
  directories: string[]
  files: { localPath: string; remotePath: string }[]
}

/**
 * #16432: this used to base64 every artifact into one JSON array and push the whole ~1.9MB string
 * into one PowerShell stdin. Base64 inflates the payload 1.33x, and Windows PowerShell 5.1 cannot
 * read a stdin that large over a non-pty ssh exec — it blocks forever instead of failing. Nothing
 * about a directory upload requires one frame: the plan carries paths only, and the bytes go per
 * file, in writes bounded by WINDOWS_STDIN_WRITE_CHUNK_BYTES.
 */
export async function collectLocalUploadPlan(
  localDir: string,
  remoteDir: string,
  hostPlatform: RemoteHostPlatform,
  signal: AbortSignal | undefined,
  plan: LocalUploadPlan = { directories: [], files: [] },
  budget = new DirectoryTransferBudget(),
  depth = 0
): Promise<LocalUploadPlan> {
  throwIfAborted(signal)
  budget.record([localDir, remoteDir], depth)
  plan.directories.push(remoteDir)
  for await (const entry of await opendir(localDir)) {
    throwIfAborted(signal)
    const localPath = pathJoin(localDir, entry.name)
    const remotePath = joinRemotePath(hostPlatform, remoteDir, entry.name)
    const statResult = await lstat(localPath)
    if (statResult.isSymbolicLink() || (!statResult.isFile() && !statResult.isDirectory())) {
      continue
    }
    if (statResult.isDirectory()) {
      await collectLocalUploadPlan(
        localPath,
        remotePath,
        hostPlatform,
        signal,
        plan,
        budget,
        depth + 1
      )
      continue
    }
    budget.record([localPath, remotePath], depth + 1)
    plan.files.push({ localPath, remotePath })
  }
  return plan
}

/**
 * Creates the upload's directories, preferring sftp's own `mkdir`.
 *
 * The PowerShell fallback keeps the JSON envelope, batched under one stdin's worth: a path list is
 * metadata, so it stays in the hundreds of bytes even for a deep tree. It is still a redirected
 * stdin read though, so on Windows PowerShell 5.1 it carries the same defect as any other — which
 * is why sftp is tried first even for a payload this small.
 */
async function createWindowsUploadDirectories(
  target: SshTarget,
  directories: readonly string[],
  options: SystemSshOperationOptions
): Promise<void> {
  let batch: string[] = []
  let batchBytes = 0
  const flush = async (): Promise<void> => {
    if (batch.length === 0) {
      return
    }
    const pending = batch
    const payload = JSON.stringify(batch)
    batch = []
    batchBytes = 0
    throwIfAborted(options.signal)
    await getWindowsRemoteWriteCapabilities(target).runWithFallback(
      'sftp-subsystem',
      async () => {
        try {
          await makeDirectoriesViaSftp(target, pending, options)
        } catch (error) {
          // A directory sftp cannot address is this batch's problem, not the host's verdict.
          if (!isSftpPathUnsupportedError(error)) {
            throw error
          }
          await createWindowsUploadDirectoriesViaPowerShell(target, payload, options)
        }
      },
      () => createWindowsUploadDirectoriesViaPowerShell(target, payload, options),
      isSftpUnavailableError
    )
  }
  for (const directory of directories) {
    const entryBytes = Buffer.byteLength(directory) + 4
    if (batch.length > 0 && batchBytes + entryBytes > WINDOWS_STDIN_WRITE_CHUNK_BYTES) {
      await flush()
    }
    batch.push(directory)
    batchBytes += entryBytes
  }
  await flush()
}

async function createWindowsUploadDirectoriesViaPowerShell(
  target: SshTarget,
  payload: string,
  options: SystemSshOperationOptions
): Promise<void> {
  const channel = spawnSystemSshCommand(target, makeWindowsCreateDirectoriesCommand(), {
    wrapCommand: false,
    ...getSystemSshBuildArgsFromOperationOptions(options)
  })
  const closePromise = awaitWithSystemSshAbort(
    options.signal,
    () => channel.close(),
    waitForChannelClose(channel, 'windows relay upload mkdir', WINDOWS_STDIN_WRITE_TIMEOUT_MS)
  )
  if (!options.signal?.aborted) {
    channel.stdin.end(payload)
  }
  await closePromise
}

function makeWindowsCreateDirectoriesCommand(): string {
  return powerShellCommand(
    [
      '$ErrorActionPreference = "Stop"',
      // Reached only where the host has no sftp subsystem. Windows PowerShell 5.1 can lose a
      // redirected stdin for good when a read finds it empty (#16432); a batch this small usually
      // arrives in one piece, and "usually" is exactly why sftp is preferred.
      '$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())',
      'try { $json = $reader.ReadToEnd() } finally { $reader.Dispose() }',
      'if ([string]::IsNullOrWhiteSpace($json)) { return }',
      // `[string[]]`, not `@(...)`: ConvertFrom-Json emits the parsed array as a single pipeline
      // object, so `@(...)` wraps it in *another* array and the loop variable binds to the whole
      // thing. `[string]` of that is the paths joined by spaces, which CreateDirectory rejects with
      // "The given path's format is not supported". It only ever worked for a one-element batch,
      // where stringifying a single-element array happens to yield the element. Measured on
      // WindowsPowerShell 5.1.26100 against a three-directory tree.
      'foreach ($path in [string[]]($json | ConvertFrom-Json)) {',
      '  $null = [System.IO.Directory]::CreateDirectory($path)',
      '}'
    ].join('; ')
  )
}
