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

// Why: mirror payloads are erase/append deltas against the PTY echo. A skipped
// delta desyncs every later diff, so unlike queueTerminalLivePendingFlush this
// chain runs each send even when the previous one failed.
export function queueTerminalLiveMirrorSend(
  state: TerminalLivePendingFlushState,
  sendMirrorPayload: () => Promise<boolean>
): Promise<boolean> {
  const previousSend = state.current
  const sendPromise = (async () => {
    if (previousSend) {
      await previousSend
    }
    return sendMirrorPayload()
  })().catch(() => false)
  state.current = sendPromise
  void sendPromise.then(() => {
    if (state.current === sendPromise) {
      state.current = null
    }
  })
  return sendPromise
}
