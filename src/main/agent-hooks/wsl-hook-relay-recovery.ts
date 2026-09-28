// Restart/reinstall timer policy for WSL hook relay states. Owns the two
// self-recovery timers so the manager's state machine stays declarative:
// WHEN to retry lives here, WHAT retrying means stays in the manager.
const RUNNING_PROBE_RETRY_DELAY_MS = 60_000

export type WslRelayRecoveryState = {
  distro: string
  user?: string
  cooldownUntil: number
  restartTimer?: ReturnType<typeof setTimeout>
  reinstallTimer?: ReturnType<typeof setTimeout>
}

export type WslRelayRecoveryIo = {
  isDistroRunning: (distro: string) => Promise<boolean>
  warn: (message: string) => void
  isDisposed: () => boolean
  /** True while this state object is still the one in the manager's map. */
  isCurrent: (state: WslRelayRecoveryState) => boolean
  restart: (distro: string, user?: string) => void
  dropState: (state: WslRelayRecoveryState) => void
}

export class WslRelayRecovery {
  constructor(private io: WslRelayRecoveryIo) {}

  /** Arms the restart timer for the state's cooldown. The probe gate matters:
   *  `wsl -d` BOOTS a stopped distro, so recovery must never resurrect a VM
   *  the user shut down — a stopped distro has no live agents anyway. */
  scheduleRestart(state: WslRelayRecoveryState): void {
    if (this.io.isDisposed() || state.restartTimer) {
      return
    }
    const delayMs = Math.max(state.cooldownUntil - Date.now(), 0) + 250
    state.restartTimer = setTimeout(() => {
      state.restartTimer = undefined
      void this.restartIfDistroRunning(state)
    }, delayMs)
    state.restartTimer.unref?.()
  }

  scheduleOneShotReinstall(state: WslRelayRecoveryState, delayMs: number, run: () => void): void {
    if (this.io.isDisposed()) {
      return
    }
    state.reinstallTimer = setTimeout(() => {
      state.reinstallTimer = undefined
      run()
    }, delayMs)
    state.reinstallTimer.unref?.()
  }

  clearTimers(state: WslRelayRecoveryState): void {
    if (state.restartTimer) {
      clearTimeout(state.restartTimer)
      state.restartTimer = undefined
    }
    if (state.reinstallTimer) {
      clearTimeout(state.reinstallTimer)
      state.reinstallTimer = undefined
    }
  }

  private async restartIfDistroRunning(state: WslRelayRecoveryState): Promise<void> {
    if (this.io.isDisposed() || !this.io.isCurrent(state)) {
      return
    }
    let running: boolean
    try {
      running = await this.io.isDistroRunning(state.distro)
    } catch (error) {
      if (this.io.isDisposed() || !this.io.isCurrent(state)) {
        return
      }
      const detail = error instanceof Error ? error.message : String(error)
      this.io.warn(
        `[agent-hooks] WSL hook relay (${state.distro}): running-state probe failed; retrying in 60s: ${detail}`
      )
      state.cooldownUntil = Date.now() + RUNNING_PROBE_RETRY_DELAY_MS
      this.scheduleRestart(state)
      return
    }
    // Why: a fresh ensure() may have replaced this state during the probe
    // await — dropping/restarting here would then act on the replacement,
    // orphaning its live relay child outside the manager's map.
    if (this.io.isDisposed() || !this.io.isCurrent(state)) {
      return
    }
    if (!running) {
      this.io.warn(
        `[agent-hooks] WSL hook relay (${state.distro}): distro not running; restart skipped (next WSL terminal re-ensures)`
      )
      this.io.dropState(state)
      return
    }
    this.io.restart(state.distro, ...(state.user ? [state.user] : []))
  }
}
