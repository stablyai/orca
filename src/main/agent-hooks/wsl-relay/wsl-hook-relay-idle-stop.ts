/**
 * A running relay is the last thing holding its distro (and the WSL VM's memory) once no bridge
 * terminal remains there. After WSL_RELAY_IDLE_STOP_MS with no bridge terminal and no hook
 * traffic, it is stopped and its config parked; the next terminal or agent in that distro (a user
 * act that runs wsl.exe itself) starts it again. Nothing here starts a relay, so nothing boots.
 */
import type { WslRelayDistroState, WslRelayRestartSetup } from './wsl-hook-relay-state'
import { wslHookRelayStateKey } from './wsl-hook-relay-state-key'
import { captureWslRelaySetup, seedWslRelayState } from './wsl-hook-relay-state-machine'
import type { WslHookRelayManagerDeps } from './wsl-hook-relay-deps'
import type { WslRelayRecovery } from './wsl-hook-relay-recovery'
import type { DaemonBridgeSessionVerdict } from './wsl-bridge-daemon-sessions'

export const WSL_RELAY_IDLE_STOP_MS = 5 * 60_000

export type WslRelayIdleStopDeps = {
  idleMs?: number
  states: Map<string, WslRelayDistroState>
  livePtyCount: (distro: string) => number
  /** The daemon's own inventory, read before a stop; anything but 'none' keeps the relay. */
  daemonBridgeSessions: (distro: string) => Promise<DaemonBridgeSessionVerdict>
  isDisposed: () => boolean
  clearRecoveryTimers: (state: WslRelayDistroState) => void
  warn: (message: string) => void
}

export class WslRelayIdleStop {
  private readonly timers = new Map<WslRelayDistroState, ReturnType<typeof setTimeout>>()
  private readonly parked = new Map<string, WslRelayRestartSetup>()

  constructor(private readonly deps: WslRelayIdleStopDeps) {}

  /** Re-evaluate after a relay came up, a bridge terminal came or went, or a hook arrived. */
  update(state: WslRelayDistroState): void {
    this.clear(state)
    if (state.phase !== 'running' || this.deps.livePtyCount(state.distro) > 0) {
      return
    }
    const timer = setTimeout(() => {
      this.timers.delete(state)
      void this.stopIfIdle(state)
    }, this.deps.idleMs ?? WSL_RELAY_IDLE_STOP_MS)
    timer.unref?.()
    this.timers.set(state, timer)
  }

  /** Hook traffic over this relay's link counts as activity. */
  noteTraffic<TArgs extends unknown[]>(
    state: WslRelayDistroState,
    ingest: (...args: TArgs) => void
  ): (...args: TArgs) => void {
    return (...args) => {
      this.update(state)
      ingest(...args)
    }
  }

  /** A bridge terminal count changed for this distro (state key). */
  presenceChanged(key: string): void {
    const changed = key ? [this.deps.states.get(key)] : [...this.deps.states.values()]
    for (const state of changed) {
      if (state) {
        this.update(state)
      }
    }
  }

  private clear(state: WslRelayDistroState): void {
    const timer = this.timers.get(state)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(state)
    }
  }

  /** Before an ensure: an idle-stopped relay comes back with the config it served. */
  restoreParked(distro: string): void {
    const key = wslHookRelayStateKey(distro)
    const setup = this.parked.get(key)
    if (!setup) {
      return
    }
    this.parked.delete(key)
    if (!this.deps.states.has(key)) {
      this.deps.states.set(key, seedWslRelayState(distro, setup))
    }
  }

  /** Hooks off or quit: no timer outlives the relays; a quit also forgets what was parked. */
  dispose(permanent: boolean): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    if (permanent) {
      this.parked.clear()
    }
  }

  private async stopIfIdle(state: WslRelayDistroState): Promise<void> {
    if (state.phase !== 'running' || this.deps.livePtyCount(state.distro) > 0) {
      return
    }
    const verdict = await this.deps.daemonBridgeSessions(state.distro)
    // A session no pane in this run has noted (a hidden or headless one after a relaunch) still
    // needs its hooks; so does one the daemon couldn't vouch for. Look again a window later.
    if (verdict !== 'none') {
      this.update(state)
      return
    }
    // Re-checked after the await: a terminal or hook may have come meanwhile.
    if (
      !this.timers.has(state) &&
      state.phase === 'running' &&
      this.deps.livePtyCount(state.distro) === 0
    ) {
      this.stop(state)
    }
  }

  /** Detach first: the link's death then reads as superseded, so recovery never restarts it. */
  private stop(state: WslRelayDistroState): void {
    const key = wslHookRelayStateKey(state.distro)
    if (this.deps.isDisposed() || this.deps.states.get(key) !== state) {
      return
    }
    const { mux, child } = state
    state.mux = undefined
    this.deps.states.delete(key)
    this.parked.set(key, captureWslRelaySetup(state))
    this.deps.clearRecoveryTimers(state)
    mux?.dispose()
    child?.kill()
    this.deps.warn(`[agent-hooks] WSL hook relay for '${state.distro}' stopped: idle`)
  }
}

/** The relay manager's idle-stop, listening to bridge terminals coming and going. */
export function createWslRelayIdleStopForManager(manager: {
  deps: () => WslHookRelayManagerDeps
  states: Map<string, WslRelayDistroState>
  recovery: Pick<WslRelayRecovery, 'clearTimers'>
  isDisposed: () => boolean
}): WslRelayIdleStop {
  const deps = manager.deps()
  const idle = new WslRelayIdleStop({
    idleMs: deps.idleStopMs,
    states: manager.states,
    livePtyCount: (distro) => manager.deps().bridgePtyPresence.count(distro),
    daemonBridgeSessions: (distro) => manager.deps().daemonBridgeSessions(distro),
    isDisposed: manager.isDisposed,
    clearRecoveryTimers: (state) => manager.recovery.clearTimers(state),
    warn: (message) => manager.deps().warn(message)
  })
  deps.bridgePtyPresence.onChange((key) => idle.presenceChanged(key))
  return idle
}
