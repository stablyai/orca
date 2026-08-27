import type { SubprocessHandle } from './session-subprocess-handle'
import { normalizePtySize } from './daemon-pty-size'
import { TerminalAttachCanceledError } from './daemon-errors'
import { createDaemonPtyEnvironment } from './pty-subprocess/spawn-environment'
import { createPtyShellLaunchPlan } from './pty-subprocess/shell-launch-plan'
import { spawnNativeDaemonPty, type SpawnedDaemonPty } from './pty-subprocess/native-pty-spawn'
import {
  formatPtySpawnError,
  preflightPtySpawn,
  preflightPtySpawnHealth,
  runPtySpawnHealthProbe
} from './pty-subprocess/spawn-preflight'
import { createDaemonPtySubprocessHandle } from './pty-subprocess/subprocess-handle'
import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type { TuiAgent } from '../../shared/tui-agent'

const PTY_SPAWN_HEALTH_RETRY_ATTEMPTS = 2

export type PtySubprocessOptions = {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  command?: string
  startupCommandDelivery?: StartupCommandDelivery
  launchAgent?: TuiAgent
  /** Explicit shell executable path/basename requested by the renderer. */
  shellOverride?: string
  terminalWindowsWslDistro?: string | null
  terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
  isCanceled?: () => boolean
  /** Aborts in-progress cwd validation; `isCanceled` is only polled between steps. */
  cancelSignal?: AbortSignal
  onMacosTccSpawnStrategy?: (strategy: 'wrapped' | 'direct') => void
}

export async function checkPtySpawnHealth(): Promise<void> {
  if (!preflightPtySpawnHealth()) {
    return
  }
  let lastError: unknown
  for (let attempt = 1; attempt <= PTY_SPAWN_HEALTH_RETRY_ATTEMPTS; attempt++) {
    try {
      await runPtySpawnHealthProbe()
      return
    } catch (error) {
      lastError = error
      if (attempt < PTY_SPAWN_HEALTH_RETRY_ATTEMPTS) {
        console.warn(
          `[daemon] PTY spawn health probe attempt ${attempt} failed; retrying`,
          error instanceof Error ? error.message : error
        )
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * Spawns the daemon-owned PTY subprocess for a terminal session.
 *
 * Launch planning stays ahead of validation so Windows validates the effective
 * host or WSL cwd selected by the same fallback chain that native spawn uses.
 * The handle then owns all event buffering, foreground identity, and teardown.
 */
export async function createPtySubprocess(opts: PtySubprocessOptions): Promise<SubprocessHandle> {
  const size = normalizePtySize(opts.cols, opts.rows)
  const env = createDaemonPtyEnvironment(opts)
  const launch = createPtyShellLaunchPlan(opts, env)

  await preflightPtySpawn({
    validationCwd: launch.validationCwd,
    cwdWasExplicit: opts.cwd !== undefined,
    sessionId: opts.sessionId,
    ...(opts.cancelSignal ? { signal: opts.cancelSignal } : {})
  })
  if (opts.isCanceled?.()) {
    throw new TerminalAttachCanceledError(opts.sessionId)
  }

  let spawned: SpawnedDaemonPty
  try {
    spawned = spawnNativeDaemonPty({
      shellPath: launch.shellPath,
      shellArgs: launch.shellArgs,
      spawnCwd: launch.spawnCwd,
      env,
      cols: size.cols,
      rows: size.rows,
      windowsFallbackAttempts: launch.windowsFallbackAttempts,
      onMacosTccSpawnStrategy: opts.onMacosTccSpawnStrategy
    })
  } catch (error) {
    if (process.platform === 'win32') {
      throw formatPtySpawnError(error, launch.shellPath, launch.spawnCwd)
    }
    throw error
  }

  return createDaemonPtySubprocessHandle({
    process: spawned.process,
    shellPath: spawned.shellPath,
    spawnCwd: spawned.spawnCwd,
    env,
    startupCommandDeliveredInShellArgs:
      spawned.startupCommandDeliveredInShellArgs ?? launch.startupCommandDeliveredInShellArgs,
    reportsChildExitStatus: spawned.reportsChildExitStatus,
    requestedCwd: opts.cwd,
    sessionId: opts.sessionId,
    startupAgentRecognition: launch.startupAgentRecognition
  })
}
