import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import type { SshTarget } from '../../../shared/ssh-types'
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
import { SystemSshCommandExitError, throwIfAborted } from './system-ssh-operation-lifecycle'
import { runProcess } from '@orca/process-host'

/** Subsystem refusal permits transport fallback. */
class SftpSubsystemUnavailableError extends Error {
  constructor(detail: string) {
    super(`Remote host has no usable sftp subsystem: ${detail}`)
    this.name = 'SftpSubsystemUnavailableError'
  }
}

/** Cache only host-wide SFTP unavailability; permission/path failures must surface without retrying the payload. */
export function isSftpUnavailableError(error: unknown): boolean {
  return error instanceof SftpSubsystemUnavailableError || error instanceof SftpArgTranslationError
}

/** Path refusal applies only to this operation; caching it would degrade every later host write. */
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
  // Prefer the selected SSH install's sibling SFTP client so dual installs cannot mix clients/options.
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

function findSystemSftp(): string | null {
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

const SUBSYSTEM_REFUSED_PATTERN = /subsystem request failed|no such file or directory.*sftp-server/i

type SftpBatchOptions = SystemSshBuildArgsOptions & { signal?: AbortSignal }

/** Feed the local SFTP client, avoiding remote PowerShell redirected-stdin reads. */
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
      input: `${commands.join('\n')}\n`,
      // Large healthy uploads may be slow; ServerAlive detects dead peers without a wall-clock cap.
      timeoutMs: null,
      signal: options?.signal
    })
  } catch (error) {
    // A client that cannot start moved no payload; permit fallback.
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
  // Transport loss proves no host capability; do not cache it as SFTP refusal.
  if (CONTACT_LOST_PATTERN.test(detail)) {
    throw new Error(`sftp batch failed (exit ${result.code}): ${detail}`)
  }
  throw new SystemSshCommandExitError('sftp batch', result.code, detail, result.signal)
}

const CONTACT_LOST_PATTERN =
  /connection (?:closed|reset|lost|timed out|refused)|broken pipe|timeout, server .* not responding/i

/** Prefix mkdir with - so an already-existing directory does not abort the idempotent batch. */
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
