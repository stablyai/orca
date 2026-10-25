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
  shellOverride?: string
  /** Unix interactive profile args are ignored for command and agent launches. */
  terminalShellArgs?: string[]
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

/** Plan first so validation uses the host or WSL cwd that spawn will actually use. */
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
    spawned = await spawnNativeDaemonPty({
      shellPath: launch.shellPath,
      shellArgs: launch.shellArgs,
      spawnCwd: launch.spawnCwd,
      env,
      cols: size.cols,
      rows: size.rows,
      windowsFallbackAttempts: launch.windowsFallbackAttempts,
      // User-configured shell args can carry a command (`pwsh -Command ...`); never respawn those.
      primaryArgsRespawnSafe:
        !launch.startupCommandDeliveredInShellArgs && !opts.terminalShellArgs?.length,
      onMacosTccSpawnStrategy: opts.onMacosTccSpawnStrategy,
      ...(opts.cancelSignal ? { signal: opts.cancelSignal } : {})
    })
  } catch (error) {
    // A cancel that lands while ConPTY's startup is awaited is a cancel, not a spawn failure.
    if (opts.cancelSignal?.aborted) {
      throw new TerminalAttachCanceledError(opts.sessionId)
    }
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
    startupAgentRecognition: launch.startupAgentRecognition,
    // Claimed here, synchronously with the handle's own subscription, so no event falls between.
    ...(spawned.claimStartupEvents ? { startupEvents: spawned.claimStartupEvents() } : {})
  })
}
