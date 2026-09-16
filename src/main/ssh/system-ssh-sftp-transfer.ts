import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import type { SshTarget } from '../../shared/ssh-types'
import { buildSshArgs, type SystemSshBuildArgsOptions } from './system-ssh-args'
import { findSystemSsh } from './system-ssh-binary'
import {
  SftpArgTranslationError,
  translateSshArgsToSftpArgs,
  withSftpKeepalive
} from './system-ssh-sftp-args'
import {
  quoteSftpBatchArgument,
  toSftpRemotePath,
  UnsupportedSftpPathError
} from './system-ssh-sftp-path'
import { throwIfAborted } from './system-ssh-operation-lifecycle'
import { runProcess } from '../../shared/child-process/run-process'

/** The host answered, but not with an sftp subsystem. The caller must fall back, not fail. */
export class SftpSubsystemUnavailableError extends Error {
  constructor(detail: string) {
    super(`Remote host has no usable sftp subsystem: ${detail}`)
    this.name = 'SftpSubsystemUnavailableError'
  }
}

/**
 * True for the errors that mean "this host cannot serve sftp at all".
 *
 * Host-scoped, and therefore the only errors safe to remember: a capability cache keyed by host
 * turns anything it accepts into a verdict about every later write to that host. Deliberately
 * narrow — a permission denial or a missing directory is a real failure that must surface, not a
 * reason to retry the whole upload down a slower path.
 */
export function isSftpUnavailableError(error: unknown): boolean {
  return error instanceof SftpSubsystemUnavailableError || error instanceof SftpArgTranslationError
}

/**
 * True when *this path* cannot be spelled for sftp, which says nothing about the host.
 *
 * Kept apart from the host verdict on purpose. A UNC destination, or a local file whose name
 * contains a newline, is a property of one operation; caching it would degrade every subsequent
 * write to that host for the cache's whole retry window on the strength of one odd filename.
 */
export function isSftpPathUnsupportedError(error: unknown): boolean {
  return error instanceof UnsupportedSftpPathError
}

/** Neither kind of refusal moves a byte, so a staged file cannot exist to sweep. */
export function isSftpRefusalBeforeStaging(error: unknown): boolean {
  return isSftpUnavailableError(error) || isSftpPathUnsupportedError(error)
}

function systemSftpCandidates(sshPath: string | null, platform: NodeJS.Platform): string[] {
  const pathApi = platform === 'win32' ? win32 : posix
  const executable = platform === 'win32' ? 'sftp.exe' : 'sftp'
  const candidates: string[] = []
  // Why the ssh binary's own directory first: a host with two OpenSSH installs must pair the sftp
  // client with the ssh that `buildSshArgs` was built for, not whichever one PATH happens to reach.
  if (sshPath) {
    candidates.push(pathApi.join(pathApi.dirname(sshPath), executable))
  }
  if (platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR
    if (systemRoot) {
      candidates.push(win32.join(systemRoot, 'System32', 'OpenSSH', executable))
    }
  } else {
    candidates.push('/usr/bin/sftp', '/usr/local/bin/sftp', '/opt/homebrew/bin/sftp')
  }
  return candidates
}

/** Locate the sftp client paired with the system ssh binary. Returns null when there is none. */
export function findSystemSftp(): string | null {
  if (process.env.ORCA_SYSTEM_SFTP_PATH) {
    return process.env.ORCA_SYSTEM_SFTP_PATH
  }
  const sshPath = findSystemSsh()
  for (const candidate of systemSftpCandidates(sshPath, process.platform)) {
    try {
      if (!statSync(candidate).isFile()) {
        continue
      }
      if (process.platform !== 'win32') {
        accessSync(candidate, constants.X_OK)
      }
      return candidate
    } catch {
      continue
    }
  }
  return findSftpOnPath()
}

function findSftpOnPath(): string | null {
  const pathValue = process.env.PATH
  if (!pathValue) {
    return null
  }
  const pathApi = process.platform === 'win32' ? win32 : posix
  const executable = process.platform === 'win32' ? 'sftp.exe' : 'sftp'
  for (const entry of pathValue.split(pathApi.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, '')
    if (!directory) {
      continue
    }
    const candidate = pathApi.join(directory, executable)
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

/**
 * OpenSSH prints this when the server refuses the subsystem — a host with `Subsystem sftp`
 * commented out, or an internal-sftp block that does not apply to this user.
 */
const SUBSYSTEM_REFUSED_PATTERN = /subsystem request failed|no such file or directory.*sftp-server/i

export type SftpBatchOptions = SystemSshBuildArgsOptions & { signal?: AbortSignal }

/**
 * Runs one sftp batch script.
 *
 * The script goes to the *local* sftp client's stdin, which is the point: no remote process ever
 * reads a redirected stdin, so none of this rides the Windows PowerShell stdin defect.
 */
export async function runSftpBatch(
  target: SshTarget,
  commands: readonly string[],
  options?: SftpBatchOptions
): Promise<void> {
  throwIfAborted(options?.signal)
  const sftpPath = findSystemSftp()
  if (!sftpPath) {
    throw new SftpSubsystemUnavailableError('no sftp client binary found alongside ssh')
  }
  const args = withSftpKeepalive(translateSshArgsToSftpArgs(buildSshArgs(target, options)))
  let result
  try {
    result = await runProcess({
      program: sftpPath,
      args: ['-b', '-', ...args],
      // `-b -` takes the script on stdin, and that stdin is the *local* client's — no remote
      // process reads a pipe anywhere in this transfer, which is the whole point of preferring it.
      input: `${commands.join('\n')}\n`,
      // Why no timeout: a large upload is legitimately slow, and a wall-clock cap would fail a
      // healthy transfer on a slow link. A dead peer is caught by the ServerAlive options instead.
      timeoutMs: null,
      signal: options?.signal
    })
  } catch (error) {
    // A client that will not start is "this host cannot do sftp" from the caller's side, not a
    // transfer failure: the payload never left. Falling back is the only useful answer.
    throw new SftpSubsystemUnavailableError(
      `sftp client at ${sftpPath} could not be started: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (result.code === 0) {
    return
  }
  throwIfAborted(options?.signal)
  const detail = result.stderr.trim()
  if (SUBSYSTEM_REFUSED_PATTERN.test(detail)) {
    throw new SftpSubsystemUnavailableError(detail)
  }
  throw new Error(`sftp batch failed (exit ${result.code}): ${detail}`)
}

/**
 * Creates remote directories, parents first.
 *
 * `-mkdir` keeps sftp going when a directory is already there; batch mode otherwise aborts the
 * whole script on the first non-zero status, which for an idempotent tree walk is not a failure.
 */
export function makeDirectoriesViaSftp(
  target: SshTarget,
  remoteDirectories: readonly string[],
  options?: SftpBatchOptions
): Promise<void> {
  const commands = remoteDirectories.map(
    (directory) => `-mkdir ${quoteSftpBatchArgument(toSftpRemotePath(directory))}`
  )
  if (commands.length === 0) {
    return Promise.resolve()
  }
  return runSftpBatch(target, commands, options)
}
