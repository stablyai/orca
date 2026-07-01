export type TerminalLivePendingFlushState = {
  current: Promise<boolean> | null
}

export function waitForTerminalLivePendingFlush(
  state: TerminalLivePendingFlushState
): Promise<boolean> {
  return state.current ?? Promise.resolve(true)
}

export function trackTerminalLivePendingFlush(
  state: TerminalLivePendingFlushState,
  sendPendingText: () => Promise<boolean>
): Promise<boolean> {
  const flushPromise = sendPendingText().catch(() => false)
  state.current = flushPromise
  void flushPromise.then(() => {
    if (state.current === flushPromise) {
      state.current = null
    }
  })
  return flushPromise
}
