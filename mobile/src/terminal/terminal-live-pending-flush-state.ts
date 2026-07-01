export type TerminalLivePendingFlushState = {
  current: Promise<boolean> | null
}

export function waitForTerminalLivePendingFlush(
  state: TerminalLivePendingFlushState
): Promise<boolean> {
  return state.current ?? Promise.resolve(true)
}

export function queueTerminalLivePendingFlush(
  state: TerminalLivePendingFlushState,
  sendPendingText: () => Promise<boolean>
): Promise<boolean> {
  const previousFlush = state.current
  const flushPromise = (async () => {
    if (previousFlush && !(await previousFlush)) {
      return false
    }
    return sendPendingText()
  })().catch(() => false)
  state.current = flushPromise
  void flushPromise.then(() => {
    if (state.current === flushPromise) {
      state.current = null
    }
  })
  return flushPromise
}
