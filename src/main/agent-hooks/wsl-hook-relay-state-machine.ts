import { WslRelayRecovery } from './wsl-hook-relay-recovery'
import type { WslHookRelayManagerDeps } from './wsl-hook-relay-deps'
import type { WslRelayDistroState, WslRelayRestartSetup } from './wsl-hook-relay-state'
import { wslHookRelayStateKey } from './wsl-hook-relay-state-key'
import { FAILURE_COOLDOWN_MAX_MS } from './wsl-hook-relay-deps'
import { noteWslDistroMayHaveStopped } from '../wsl/wsl-unc-access-gate'

type RelayFailureState = {
  distro: string
  phase: 'starting' | 'running' | 'failed'
  failures: number
  cooldownUntil: number
  child?: unknown
  mux?: { dispose(): void }
  reinstallTimer?: ReturnType<typeof setTimeout>
}

type RelayFailureDeps = {
  warn(message: string): void
}

type RelayRecovery = {
  scheduleRestart(state: RelayFailureState): void
}

export function markWslRelayFailed(
  state: RelayFailureState,
  message: string,
  options: { cooldownBaseMs: number },
  deps: RelayFailureDeps,
  recovery: RelayRecovery
): void {
  state.phase = 'failed'
  state.failures++
  state.child = undefined
  state.mux = undefined
  if (state.reinstallTimer) {
    clearTimeout(state.reinstallTimer)
    state.reinstallTimer = undefined
  }
  state.cooldownUntil =
    Date.now() + Math.min(options.cooldownBaseMs * state.failures, FAILURE_COOLDOWN_MAX_MS)
  deps.warn(`[agent-hooks] WSL hook relay: ${message}`)
  // A dead link is the earliest sign the distro stopped; UNC reads must re-check before touching it.
  noteWslDistroMayHaveStopped(state.distro)
  recovery.scheduleRestart(state)
}

export function resumeWslStoppedRelays(
  stopped: Map<string, string | undefined>,
  isDistroRunning: (distro: string) => Promise<boolean>,
  ensure: (distro: string, home: string | undefined) => void
): void {
  const distros = [...stopped]
  stopped.clear()
  for (const [distro, home] of distros) {
    void isDistroRunning(distro)
      .then((running) => {
        if (running) {
          ensure(distro, home)
        }
      })
      .catch(() => undefined)
  }
}

export async function resolveWslDefaultDistro(
  current: string | null,
  listDistros: () => Promise<string[]>
): Promise<string | null> {
  if (current) {
    return current
  }
  try {
    return (await listDistros())[0] ?? null
  } catch {
    return null
  }
}

type WslRelayEnsure = (
  distro: string,
  codexHomePath?: string,
  launchKind?: 'pi' | 'omp'
) => Promise<void>

export function captureWslRelaySetup(state: WslRelayDistroState): WslRelayRestartSetup {
  return {
    codexHomePath: state.codexHomePath,
    claudeAgentViewDir: state.claudeAgentViewDir,
    claudeConfigDir: state.claudeConfigDir,
    opencodeOverlayDir: state.opencodeOverlayDir,
    opencode2OverlayDir: state.opencode2OverlayDir,
    piAgentDir: state.piAgentDir,
    ompStatusExtension: state.ompStatusExtension,
    launchKinds: [...state.launchKinds]
  }
}

/** Brings a relay back with everything it served before, even after its state was dropped. */
export async function restartWslRelay(
  states: Map<string, WslRelayDistroState>,
  ensure: WslRelayEnsure,
  distro: string,
  setup: WslRelayRestartSetup
): Promise<void> {
  const key = wslHookRelayStateKey(distro)
  let seed: WslRelayDistroState | undefined
  if (!states.has(key)) {
    // A cooled-down failed state: ensure replaces it with a starting relay that inherits its config.
    seed = {
      distro,
      ...setup,
      launchKinds: new Set(setup.launchKinds),
      phase: 'failed',
      failures: 0,
      cooldownUntil: 0
    }
    states.set(key, seed)
  }
  // No Codex home argument: ensure keeps the seed's, and never overwrites a newer relay's.
  const ensures = [ensure(distro)]
  for (const launchKind of setup.launchKinds) {
    ensures.push(ensure(distro, undefined, launchKind))
  }
  await Promise.all(ensures)
  // An ensure that bailed (gate closed, no bundle) must not leave the seed behind.
  if (seed && states.get(key) === seed) {
    states.delete(key)
  }
}

/** The relay manager's recovery: restarts only into a distro confirmed running, never boots it. */
export function createWslRelayRecoveryForManager(manager: {
  deps: () => WslHookRelayManagerDeps
  states: Map<string, WslRelayDistroState>
  isDisposed: () => boolean
  ensure: WslRelayEnsure
}): WslRelayRecovery {
  const { states } = manager
  return new WslRelayRecovery({
    isDistroRunning: (distro, startedAfter) =>
      manager.deps().isDistroRunning(distro, { startedAfter }),
    deferUntilRunning: (distro, task) =>
      manager.deps().deferUntilRunning(distro, 'wsl-hook-relay-restart', task),
    warn: (message) => manager.deps().warn(message),
    isDisposed: manager.isDisposed,
    isCurrent: (state) => states.get(wslHookRelayStateKey(state.distro)) === state,
    captureSetup: (state) => {
      const current = states.get(wslHookRelayStateKey(state.distro))
      return current ? captureWslRelaySetup(current) : { launchKinds: [] }
    },
    restart: (distro, setup) => void restartWslRelay(states, manager.ensure, distro, setup),
    dropState: (state) => {
      const key = wslHookRelayStateKey(state.distro)
      if (states.get(key) === state) {
        states.delete(key)
      }
    }
  })
}
