import type { PtyCreationDisposition } from '../../../shared/terminal/pty/lifecycle/pty-creation-disposition'
import { TerminalCreationWork } from '../terminal-host/terminal-creation-work'
import type { SubprocessHandle } from '../sessions/session-subprocess-handle'
import { normalizePtySize } from '../protocol/daemon-pty-size'
import { TerminalAttachCanceledError } from '../protocol/daemon-errors'
import { createDaemonPtyEnvironment } from './spawn-environment'
import { createPtyShellLaunchPlan, type PtyShellLaunchPlan } from './shell-launch-plan'
import { discardStagedStartupCommand } from '../../../shared/shell/launch/startup-command-staging'
import {
  createShellWrapperStartupClaim,
  takeShellWrapperStartupClaim
} from './shell-wrapper-startup-claim'
import { spawnNativeDaemonPty, type SpawnedDaemonPty } from './native-pty-spawn'
import {
  formatPtySpawnError,
  preflightPtySpawn,
  preflightPtySpawnHealth,
  runPtySpawnHealthProbe
} from './spawn-preflight'
import { createDaemonPtySubprocessHandle } from './subprocess-handle'
import type { StartupCommandDelivery } from '../../../shared/agent-launch/startup/codex-startup-delivery'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'

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
  /** The session will hold a readiness barrier, so the wrapper may run the command itself. */
  shellReadySupported?: boolean
  launchAgent?: TuiAgent
  shellOverride?: string
  /** Unix interactive profile args are ignored for command and agent launches. */
  terminalShellArgs?: string[]
  terminalWindowsWslDistro?: string | null
  terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
  onCreationDisposition?: (disposition: PtyCreationDisposition) => void
  assertCreateAllowed?: () => void
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
  const work = new TerminalCreationWork()
  let launch: PtyShellLaunchPlan | undefined
  let startupClaimPath: string | null = null
  try {
    const size = normalizePtySize(opts.cols, opts.rows)
    const env = createDaemonPtyEnvironment(opts)
    // Only a wrapped zsh can use it; the plan decides, and an unused claim is removed below.
    startupClaimPath =
      opts.command && opts.shellReadySupported === true && process.platform !== 'win32'
        ? await createShellWrapperStartupClaim()
        : null
    launch = createPtyShellLaunchPlan(opts, env, startupClaimPath)
    if (startupClaimPath && !launch.shellWrapperStartup) {
      void takeShellWrapperStartupClaim(startupClaimPath)
    }

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
        creationWork: work,
        assertCreateAllowed: opts.assertCreateAllowed,
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
      physicalOwner: spawned.physicalOwner,
      shellPath: spawned.shellPath,
      spawnCwd: spawned.spawnCwd,
      env,
      startupCommandDeliveredInShellArgs:
        spawned.startupCommandDeliveredInShellArgs ?? launch.startupCommandDeliveredInShellArgs,
      ...(launch.shellWrapperStartup ? { shellWrapperStartup: launch.shellWrapperStartup } : {}),
      reportsChildExitStatus: spawned.reportsChildExitStatus,
      requestedCwd: opts.cwd,
      sessionId: opts.sessionId,
      startupAgentRecognition: launch.startupAgentRecognition,
      // Claimed here, synchronously with the handle's own subscription, so no event falls between.
      ...(spawned.claimStartupEvents ? { startupEvents: spawned.claimStartupEvents() } : {})
    })
  } catch (error) {
    // No shell will source a staged launch script whose spawn failed.
    if (launch?.shellWrapperStartup) {
      discardStagedStartupCommand(launch.shellWrapperStartup.staging)
    }
    if (startupClaimPath) {
      void takeShellWrapperStartupClaim(startupClaimPath)
    }
    throw error
  } finally {
    await work.finish()
    opts.onCreationDisposition?.(await work.completion)
  }
}
