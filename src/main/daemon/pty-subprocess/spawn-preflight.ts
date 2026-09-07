import * as pty from 'node-pty'
import { statSync } from 'node:fs'
import { release } from 'node:os'
import {
  ensureNodePtySpawnHelperExecutable,
  getNodePtySpawnHelperCandidates,
  validateWorkingDirectoryAsync,
  WorkingDirectoryValidationAbortedError
} from '../../providers/local-pty-utils'
import { resolveSafePtyDefaultCwd } from '../../providers/pty-default-cwd'
import { TerminalAttachCanceledError } from '../daemon-errors'
import { DaemonProtocolError } from '../types'

const PTY_SPAWN_HEALTH_TIMEOUT_MS = 4_000

function daemonEnvironmentDiagSuffix(): string {
  const orca = process.env.ORCA_APP_VERSION?.trim() || '0.0.0-dev'
  const systemVersion =
    (process as NodeJS.Process & { getSystemVersion?: () => string }).getSystemVersion?.() ||
    release()
  return ` (orca: ${orca}, arch: ${process.arch}, platform: ${process.platform} ${systemVersion})`
}

function formatMissingDaemonPathError(kind: 'helper' | 'cwd', path: string): DaemonProtocolError {
  const detailName = kind === 'helper' ? 'helper' : 'cwd'
  const step = kind === 'helper' ? 'posix_spawn' : 'daemon_cwd'
  const missingTarget = kind === 'helper' ? 'node-pty install' : 'working directory'
  return new DaemonProtocolError(
    `Daemon's ${missingTarget} is gone (worktree deleted?). Restart Orca. node-pty: ${step} failed: ENOENT (errno 2, No such file or directory) - ${detailName}='${path}'${daemonEnvironmentDiagSuffix()}`
  )
}

function isExistingDirectory(path: string | undefined): path is string {
  if (!path) {
    return false
  }
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function repairDaemonCwd(): string | null {
  const candidates = [process.env.ORCA_USER_DATA_PATH]
  try {
    candidates.push(resolveSafePtyDefaultCwd())
  } catch {
    // Keep daemon cwd repair best-effort even when no user terminal cwd is safe.
  }
  candidates.push(process.platform === 'win32' ? 'C:\\' : '/')
  for (const candidate of candidates) {
    if (isExistingDirectory(candidate)) {
      try {
        process.chdir(candidate)
        return candidate
      } catch {
        // Try the next stable cwd candidate.
      }
    }
  }
  return null
}

function preflightDaemonCwd(): void {
  let daemonCwd = '<unavailable>'
  try {
    daemonCwd = process.cwd()
    if (isExistingDirectory(daemonCwd)) {
      return
    }
  } catch {
    // Recover below; process.cwd() throws after the original cwd is deleted.
  }
  if (repairDaemonCwd()) {
    return
  }
  throw formatMissingDaemonPathError('cwd', daemonCwd)
}

function preflightMacNodePtySpawnEnvironment(): void {
  if (process.platform !== 'darwin') {
    return
  }
  let candidates: string[]
  try {
    candidates = getNodePtySpawnHelperCandidates()
  } catch {
    throw formatMissingDaemonPathError('helper', '<unresolved>')
  }
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return
      }
    } catch {
      // Try the next node-pty native location.
    }
  }
  throw formatMissingDaemonPathError('helper', candidates[0] ?? '<unresolved>')
}

function preflightUnixPtySpawnEnvironment(): void {
  if (process.platform === 'win32') {
    return
  }
  // Why: detached daemons can outlive their launch cwd; repair before every spawn.
  preflightDaemonCwd()
  preflightMacNodePtySpawnEnvironment()
}

function isNativeWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

export async function preflightPtySpawn(args: {
  validationCwd: string
  cwdWasExplicit: boolean
  sessionId: string
  signal?: AbortSignal
}): Promise<void> {
  ensureNodePtySpawnHelperExecutable()
  preflightUnixPtySpawnEnvironment()
  try {
    if (process.platform === 'win32') {
      if (args.cwdWasExplicit && isNativeWindowsPath(args.validationCwd)) {
        await validateWorkingDirectoryAsync(
          args.validationCwd,
          args.signal ? { signal: args.signal } : {}
        )
      }
    } else {
      await validateWorkingDirectoryAsync(
        args.validationCwd,
        args.signal ? { signal: args.signal } : {}
      )
    }
  } catch (error) {
    if (error instanceof WorkingDirectoryValidationAbortedError) {
      throw new TerminalAttachCanceledError(args.sessionId)
    }
    throw error
  }
}

export function formatPtySpawnError(err: unknown, shellPath: string, spawnCwd: string): Error {
  const message = err instanceof Error ? err.message : String(err)
  const formatted = new DaemonProtocolError(
    `Daemon failed to spawn shell "${shellPath}" with cwd "${spawnCwd}": ${message}${daemonEnvironmentDiagSuffix()}`
  )
  if (err instanceof Error && err.stack) {
    formatted.stack = err.stack
  }
  return formatted
}

export function runPtySpawnHealthProbe(): Promise<void> {
  const cwd = isExistingDirectory(process.env.ORCA_USER_DATA_PATH)
    ? process.env.ORCA_USER_DATA_PATH
    : resolveSafePtyDefaultCwd()
  let proc: pty.IPty
  try {
    proc = pty.spawn('/bin/sh', ['-c', 'exit 0'], {
      name: 'xterm-256color',
      cols: 2,
      rows: 1,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' }
    })
  } catch (err) {
    throw formatPtySpawnError(err, '/bin/sh', cwd)
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let exitDisposable: { dispose(): void } | undefined
    const finish = (error?: Error, opts?: { kill?: boolean }): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      exitDisposable?.dispose()
      if (opts?.kill) {
        try {
          proc.kill()
        } catch {
          // Best-effort cleanup for a short-lived health probe.
        }
      }
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const timer = setTimeout(() => {
      finish(new Error(`PTY spawn health check timed out after ${PTY_SPAWN_HEALTH_TIMEOUT_MS}ms`), {
        kill: true
      })
    }, PTY_SPAWN_HEALTH_TIMEOUT_MS)
    exitDisposable = proc.onExit(({ exitCode }) => {
      if (exitCode === 0) {
        finish()
      } else {
        finish(new Error(`PTY spawn health check exited with code ${exitCode}`))
      }
    })
  })
}

export function preflightPtySpawnHealth(): boolean {
  if (process.platform === 'win32') {
    return false
  }
  if (process.platform === 'darwin') {
    ensureNodePtySpawnHelperExecutable()
  }
  preflightUnixPtySpawnEnvironment()
  return true
}
