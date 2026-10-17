import { deferAppKitSceneMutation } from '../appkit-scene-mutation'

// Give startup status-item scene reconnects a heuristic grace; no native readiness signal exists.
export const MAC_MENU_BAR_ICON_STARTUP_GRACE_MS = 10_000

export type MacMenuBarIconGateDeps = {
  /** True while a quit is in flight but can still be vetoed. */
  isQuitPending: () => boolean
  /** Latest persisted preference, or null when no status item may exist (serve mode, no store). */
  readVisibility: () => boolean | null
  apply: (visible: boolean) => void
  logMilestone: (event: string, details?: Record<string, unknown>) => void
}

export type MacMenuBarIconGate = {
  /** Starts the grace once; later loads and windows neither restart nor duplicate it. */
  noteMainWindowLoaded: () => void
  /** Applies the latest preference on a fresh AppKit turn; before the gate opens, opening reads it instead. */
  requestSync: () => void
  /** Committed quit: no status item may be created afterwards. */
  close: () => void
}

/** One per process: the status item outlives windows, so neither closing nor reopening one resets the grace. */
export function createMacMenuBarIconGate(
  deps: MacMenuBarIconGateDeps,
  graceMs = MAC_MENU_BAR_ICON_STARTUP_GRACE_MS
): MacMenuBarIconGate {
  let phase: 'awaiting-load' | 'grace' | 'open' | 'closed' = 'awaiting-load'
  let timer: ReturnType<typeof setTimeout> | null = null
  let syncQueued = false

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const startTimer = (run: () => void): void => {
    if (timer) {
      return
    }
    timer = setTimeout(() => {
      timer = null
      run()
    }, graceMs)
  }

  const sync = (): void => {
    syncQueued = false
    if (phase !== 'open') {
      return
    }
    if (deps.isQuitPending()) {
      // Why retry: a renderer or the updater can veto this quit, and nothing else re-requests the icon.
      startTimer(requestSync)
      return
    }
    // Why: this write supersedes any quit retry still pending.
    clearTimer()
    const visible = deps.readVisibility()
    if (visible !== null) {
      deps.apply(visible)
    }
  }

  // Why coalesce: a settings burst lands as one native call that reads the final preference.
  const requestSync = (): void => {
    if (phase !== 'open' || syncQueued) {
      return
    }
    syncQueued = true
    deferAppKitSceneMutation(sync)
  }

  return {
    noteMainWindowLoaded: () => {
      if (phase !== 'awaiting-load') {
        return
      }
      phase = 'grace'
      deps.logMilestone('tray-gate-armed', { graceMs })
      startTimer(() => {
        phase = 'open'
        deps.logMilestone('tray-gate-open')
        requestSync()
      })
    },
    requestSync,
    close: () => {
      phase = 'closed'
      clearTimer()
    }
  }
}
