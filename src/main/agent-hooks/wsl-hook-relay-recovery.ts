export type WslRelayRecoveryState = {
  distro: string
  cooldownUntil: number
  restartTimer?: ReturnType<typeof setTimeout>
  reinstallTimer?: ReturnType<typeof setTimeout>
}

export type WslRelayRecoveryIo = {
  isDistroRunning: (distro: string) => Promise<boolean>
  warn: (message: string) => void
  isDisposed: () => boolean
  isCurrent: (state: WslRelayRecoveryState) => boolean
  restart: (distro: string) => void
  dropState: (state: WslRelayRecoveryState) => void
}

export class WslRelayRecovery {
  constructor(private io: WslRelayRecoveryIo) {}

  /** Check distro liveness before restarting so recovery cannot boot a stopped VM. */
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
    const running = await this.io.isDistroRunning(state.distro)
    // The probe await may outlive state replacement; never drop or restart the replacement relay.
    if (this.io.isDisposed() || !this.io.isCurrent(state)) {
      return
    }
    if (!running) {
      this.io.warn(
        `[agent-hooks] WSL hook relay (${state.distro}): distro not running (or probe failed); restart skipped (next WSL terminal re-ensures)`
      )
      this.io.dropState(state)
      return
    }
    this.io.restart(state.distro)
  }
}
