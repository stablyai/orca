// Why: webContents-scoped auto-expiring flag so an intent can't leak to a later renderer load; `consume` clears on match for one-shot signals.
export function createWebContentsTimedFlag(defaultDurationMs = 10_000): {
  mark: (webContentsId: number, durationMs?: number) => void
  clear: (webContentsId?: number) => void
  matches: (webContentsId: number, options?: { consume?: boolean }) => boolean
} {
  let state: { webContentsId: number; until: number } | null = null
  return {
    mark(webContentsId, durationMs = defaultDurationMs) {
      state = { webContentsId, until: Date.now() + durationMs }
    },
    clear(webContentsId) {
      if (webContentsId === undefined || state?.webContentsId === webContentsId) {
        state = null
      }
    },
    matches(webContentsId, options) {
      if (!state || Date.now() > state.until) {
        state = null
        return false
      }
      if (state.webContentsId !== webContentsId) {
        return false
      }
      if (options?.consume) {
        state = null
      }
      return true
    }
  }
}
