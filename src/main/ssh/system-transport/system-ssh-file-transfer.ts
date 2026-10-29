import { DirectoryTransferBudget } from '../ssh-directory-transfer-budget'
import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, opendir } from 'node:fs/promises'
import { join as pathJoin } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { SshTarget } from '../../../shared/ssh-types'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { wrapRemoteCommandForPosixShell } from '../ssh-posix-command-wrapper'
import { findSystemSsh } from './system-ssh-binary'
import {
  buildSshArgs,
  getSystemSshBuildArgsFromOperationOptions,
  type SystemSshBuildArgsOptions
} from './system-ssh-args'
import { spawnSystemSshCommand } from './system-ssh-command'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../ssh-remote-platform'
import { powerShellCommand } from '../ssh-remote-powershell'
import {
  awaitWithSystemSshAbort,
  killProcess,
  throwIfAborted,
  waitForChannelClose,
  waitForProcess,
  isHostAnsweredSystemSshExit,
  type ProcessResult
} from './system-ssh-operation-lifecycle'
import { uploadFileViaSystemSsh, writeBufferViaSystemSsh } from './system-ssh-file-binary-transfer'
import {
  WINDOWS_STDIN_WRITE_CHUNK_BYTES,
  WINDOWS_STDIN_WRITE_TIMEOUT_MS
} from './system-ssh-windows-write-strategy'
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
  const remoteCommand = `mkdir -p ${quotePosixShell(remoteDir)} && tar -xzf - -C ${quotePosixShell(remoteDir)}`
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

/** Prefer the host exit over a downstream tar/pipe failure it caused; retain independent local input errors. */
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
    // Reuse source verification (O_NOFOLLOW and stability checks), transport fallback and unique staging from single-file uploads.
    await uploadFileViaSystemSsh(target, file.localPath, file.remotePath, options)
  }
}

export type LocalUploadPlan = {
  directories: string[]
  files: { localPath: string; remotePath: string }[]
}

/** Plan paths separately from payloads so per-file transport selection avoids PowerShell 5.1 redirected-stdin hangs (#16432). */
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

/** Prefer SFTP even for directory metadata: bounded PowerShell stdin batches still risk the per-read 5.1 hang (#16432). */
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
      // SFTP refusal/path fallback still risks the 5.1 empty-pipe hang, even for small metadata (#16432).
      '$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())',
      'try { $json = $reader.ReadToEnd() } finally { $reader.Dispose() }',
      'if ([string]::IsNullOrWhiteSpace($json)) { return }',
      // ConvertFrom-Json emits one array object; @() nests it and stringifies all paths together. Cast to string[] to iterate paths.
      'foreach ($path in [string[]]($json | ConvertFrom-Json)) {',
      '  $null = [System.IO.Directory]::CreateDirectory($path)',
      '}'
    ].join('; ')
  )
}
