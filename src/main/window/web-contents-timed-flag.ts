export type WebContentsTimedFlag = {
  mark: (webContentsId: number, durationMs?: number) => void
  clear: (webContentsId?: number) => void
  matches: (webContentsId: number, options?: { consume?: boolean }) => boolean
}

export function createWebContentsTimedFlag(defaultDurationMs = 10_000): WebContentsTimedFlag {
  type State = { until: number; expiryTimer?: ReturnType<typeof setTimeout> }
  const states = new Map<number, State>()
  const clear = (webContentsId?: number): void => {
    if (webContentsId === undefined) {
      for (const state of states.values()) {
        clearTimeout(state.expiryTimer)
      }
      states.clear()
      return
    }
    clearTimeout(states.get(webContentsId)?.expiryTimer)
    states.delete(webContentsId)
  }
  return {
    mark(webContentsId, durationMs = defaultDurationMs) {
      clear(webContentsId)
      const state: State = { until: Date.now() + durationMs }
      states.set(webContentsId, state)
      if (Number.isFinite(durationMs)) {
        state.expiryTimer = setTimeout(() => {
          if (states.get(webContentsId) === state) {
            states.delete(webContentsId)
          }
        }, Math.max(0, durationMs) + 1)
        state.expiryTimer.unref?.()
      }
    },
    clear,
    matches(webContentsId, options) {
      const state = states.get(webContentsId)
      if (!state || Date.now() > state.until) {
        clear(webContentsId)
        return false
      }
      if (options?.consume) {
        clear(webContentsId)
      }
      return true
    }
  }
}
