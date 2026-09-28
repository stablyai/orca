import '../xterm-env-polyfill'
import { Terminal } from '@xterm/headless'
import {
  installDeviceAttributesResponder,
  STARTUP_DA1_RESPONSE
} from '../startup-device-attributes-responder'
import type { BunPtyProcess } from './bun-pty-process-contract'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { statSync } from 'node:fs'
import { release } from 'node:os'
import { getCmdExePath } from '../../../shared/windows-batch-spawn'
import {
  validateWorkingDirectoryAsync,
  WorkingDirectoryValidationAbortedError
} from '../../providers/pty-spawn-validation'
import { resolveSafePtyDefaultCwd } from '../../providers/pty-default-cwd'
import { TerminalAttachCanceledError } from '../daemon-errors'
import { DaemonProtocolError } from '../types'
import { canUseBunPty, spawnBunPty } from './bun-pty-process'

const PTY_SPAWN_HEALTH_TIMEOUT_MS = 4_000

function daemonEnvironmentDiagSuffix(): string {
  const orca = process.env.ORCA_APP_VERSION?.trim() || '0.0.0-dev'
  const systemVersion =
    (process as NodeJS.Process & { getSystemVersion?: () => string }).getSystemVersion?.() ||
    release()
  return ` (orca: ${orca}, arch: ${process.arch}, platform: ${process.platform} ${systemVersion})`
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
  throw new DaemonProtocolError(
    `Daemon working directory is unavailable: '${daemonCwd}'. Restart Orca.${daemonEnvironmentDiagSuffix()}`
  )
}

function preflightUnixPtySpawnEnvironment(): void {
  if (process.platform === 'win32') {
    return
  }
  // Why: detached daemons can outlive their launch cwd; repair before every spawn.
  preflightDaemonCwd()
}

export async function preflightPtySpawn(args: {
  validationCwd: string
  cwdWasExplicit: boolean
  sessionId: string
  signal?: AbortSignal
}): Promise<void> {
  if (!canUseBunPty()) {
    throw new DaemonProtocolError('Terminal service requires the bundled Bun runtime')
  }
  preflightUnixPtySpawnEnvironment()
  try {
    if (process.platform === 'win32') {
      if (args.cwdWasExplicit && isWindowsAbsolutePathLike(args.validationCwd)) {
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

export async function runPtySpawnHealthProbe(): Promise<void> {
  if (!canUseBunPty()) {
    throw new DaemonProtocolError('Terminal service requires the bundled Bun runtime')
  }
  const requiresShellIdentity = process.platform === 'win32'
  const cwd = isExistingDirectory(process.env.ORCA_USER_DATA_PATH)
    ? process.env.ORCA_USER_DATA_PATH
    : resolveSafePtyDefaultCwd()
  const command =
    process.platform === 'win32'
      ? { file: getCmdExePath(), args: ['/d', '/c', 'exit', '0'] }
      : { file: '/bin/sh', args: ['-c', 'exit 0'] }
  let proc: BunPtyProcess
  try {
    const env: Record<string, string> = { TERM: 'xterm-256color' }
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value
      }
    }
    proc = spawnBunPty({ ...command, cols: 2, rows: 1, cwd, env, windowsJobKillOnClose: true })
  } catch (err) {
    throw formatPtySpawnError(err, command.file, cwd)
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const terminal = new Terminal({ cols: 2, rows: 1, scrollback: 0 })
    const releaseResponder = installDeviceAttributesResponder({
      parser: terminal.parser,
      response: STARTUP_DA1_RESPONSE,
      reply: (data) => {
        if (settled) {
          return
        }
        try {
          proc.write(data)
        } catch (error) {
          finish(formatPtySpawnError(error, command.file, cwd), { kill: true })
        }
      }
    })
    let dataDisposable: { dispose(): void } | undefined
    let exitDisposable: { dispose(): void } | undefined
    const finish = (error?: Error, opts?: { kill?: boolean }): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      exitDisposable?.dispose()
      dataDisposable?.dispose()
      releaseResponder()
      terminal.dispose()
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
    // ConPTY waits for DA1 even when the probe shell immediately exits.
    dataDisposable = proc.onData((data) => {
      if (!settled) {
        terminal.write(data)
      }
    })
    exitDisposable = proc.onExit(({ exitCode }) => {
      if (exitCode === 0) {
        const shellPid = proc.shellProcessId
        if (
          requiresShellIdentity &&
          (typeof shellPid !== 'number' ||
            !Number.isSafeInteger(shellPid) ||
            shellPid <= 0 ||
            shellPid === proc.pid)
        ) {
          finish(new Error('PTY spawn health check could not identify the Windows shell'))
        } else {
          finish()
        }
      } else {
        finish(new Error(`PTY spawn health check exited with code ${exitCode}`))
      }
    })
    if (settled) {
      exitDisposable.dispose()
    }
  })
}

export function preflightPtySpawnHealth(): boolean {
  if (!canUseBunPty()) {
    throw new DaemonProtocolError('Terminal service requires the bundled Bun runtime')
  }
  preflightUnixPtySpawnEnvironment()
  return true
}
