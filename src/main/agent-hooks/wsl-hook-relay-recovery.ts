import type { WslRelayRestartSetup } from './wsl-hook-relay-state'

export type WslRelayRecoveryState = {
  distro: string
  cooldownUntil: number
  restartTimer?: ReturnType<typeof setTimeout>
  reinstallTimer?: ReturnType<typeof setTimeout>
}

export type WslRelayRecoveryIo = {
  /** A confirmed running list read started after `startedAfter`; a failed read counts as stopped. */
  isDistroRunning: (distro: string, startedAfter: number) => Promise<boolean>
  /** Runs `task` once something else confirms the distro runs again; never boots it. */
  deferUntilRunning: (distro: string, task: () => void) => void
  warn: (message: string) => void
  isDisposed: () => boolean
  isCurrent: (state: WslRelayRecoveryState) => boolean
  /** Snapshot of the relay config; read before `dropState` discards it. */
  captureSetup: (state: WslRelayRecoveryState) => WslRelayRestartSetup
  restart: (distro: string, setup: WslRelayRestartSetup) => void
  dropState: (state: WslRelayRecoveryState) => void
}

// A failed running-list read is not proof the distro stopped; look once more after WSL's backoff.
const REPROBE_AFTER_STOPPED_MS = 30_000

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
    // Captured now: once the state is dropped, a later restart would otherwise come back bare.
    const setup = this.io.captureSetup(state)
    // Anchored at check time: a read begun right after the terminate may still list the distro.
    const running = await this.io.isDistroRunning(state.distro, performance.now())
    // The probe await may outlive state replacement; never drop or restart the replacement relay.
    if (this.io.isDisposed() || !this.io.isCurrent(state)) {
      return
    }
    if (!running) {
      this.io.warn(
        `[agent-hooks] WSL hook relay (${state.distro}): distro not running (or probe failed); staying down until it runs again or a WSL terminal re-ensures`
      )
      this.io.dropState(state)
      // E9: come back when the distro runs again (started by the user or another act), never boot it.
      let restarted = false
      const restartOnce = (confirmedRunning = false): void => {
        if (restarted || this.io.isDisposed()) {
          return
        }
        restarted = true
        // A drained deferral is a hint: the relay spawn runs wsl.exe, which boots a distro that
        // stopped again, so re-read a settled running list right before it.
        const running = confirmedRunning
          ? Promise.resolve(true)
          : this.io.isDistroRunning(state.distro, performance.now()).catch(() => false)
        void running.then((running) => {
          if (this.io.isDisposed()) {
            return
          }
          if (running) {
            this.io.restart(state.distro, setup)
            return
          }
          restarted = false
          this.io.deferUntilRunning(state.distro, () => restartOnce())
        })
      }
      this.io.deferUntilRunning(state.distro, () => restartOnce())
      const reprobe = setTimeout(() => {
        void this.io
          .isDistroRunning(state.distro, performance.now())
          .then((running) => running && restartOnce(true))
          .catch(() => {})
      }, REPROBE_AFTER_STOPPED_MS)
      reprobe.unref?.()
      return
    }
    this.io.restart(state.distro, setup)
  }
}
