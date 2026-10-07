type TerminalLiveMirrorSender = (handle: string, payload: string) => Promise<boolean>

type TerminalLivePendingRequest = {
  readonly resolve: (sent: boolean) => void
}

type TerminalLivePendingBatch = {
  readonly handle: string
  payload: string
  readonly requests: TerminalLivePendingRequest[]
  readonly sender: TerminalLiveMirrorSender
}

export type TerminalLivePendingFlushState = {
  current: Promise<boolean> | null
  activeRequests: TerminalLivePendingRequest[]
  generation: number
  pendingBatches: TerminalLivePendingBatch[]
  inFlight: number
  maxInFlight: number
  allSent: boolean
  settleCurrent: ((allSent: boolean) => void) | null
}

export function createTerminalLivePendingFlushState(): TerminalLivePendingFlushState {
  return {
    current: null,
    activeRequests: [],
    generation: 0,
    pendingBatches: [],
    inFlight: 0,
    maxInFlight: 1,
    allSent: true,
    settleCurrent: null
  }
}

export function waitForTerminalLivePendingFlush(
  state: TerminalLivePendingFlushState
): Promise<boolean> {
  return state.current ?? Promise.resolve(true)
}

function settleTerminalLiveMirrorDrain(state: TerminalLivePendingFlushState, sent: boolean): void {
  const settle = state.settleCurrent
  state.settleCurrent = null
  state.current = null
  settle?.(sent)
}

export function cancelTerminalLivePendingFlush(state: TerminalLivePendingFlushState): void {
  state.generation += 1
  const requests = [
    ...state.activeRequests,
    ...state.pendingBatches.flatMap((batch) => batch.requests)
  ]
  state.activeRequests = []
  state.pendingBatches = []
  state.inFlight = 0
  settleTerminalLiveMirrorDrain(state, false)
  requests.forEach(({ resolve }) => resolve(false))
}

function drainTerminalLiveMirrorSends(state: TerminalLivePendingFlushState): void {
  const generation = state.generation
  while (state.inFlight < state.maxInFlight) {
    const batch = state.pendingBatches.shift()
    if (!batch) {
      break
    }
    state.inFlight += 1
    state.activeRequests.push(...batch.requests)
    void batch
      .sender(batch.handle, batch.payload)
      .catch(() => false)
      .then((sent) => {
        if (state.generation !== generation) {
          return
        }
        state.inFlight -= 1
        state.activeRequests = state.activeRequests.filter(
          (request) => !batch.requests.includes(request)
        )
        batch.requests.forEach(({ resolve }) => resolve(sent))
        state.allSent &&= sent
        drainTerminalLiveMirrorSends(state)
      })
  }
  if (state.inFlight === 0 && state.pendingBatches.length === 0) {
    settleTerminalLiveMirrorDrain(state, state.allSent)
  }
}

/**
 * Mirror deltas are ordered PTY bytes. Up to `maxInFlight` sends may be outstanding, which is only
 * safe above one when the host applies them in order; bytes queued behind a full window share one
 * follow-up send.
 */
export function queueTerminalLiveMirrorSend(
  state: TerminalLivePendingFlushState,
  handle: string,
  payload: string,
  sender: TerminalLiveMirrorSender,
  maxInFlight = 1
): Promise<boolean> {
  let resolveRequest: (sent: boolean) => void = () => {}
  const request = new Promise<boolean>((resolve) => {
    resolveRequest = resolve
  })
  const pendingTail = state.pendingBatches.at(-1)
  if (pendingTail?.handle === handle && pendingTail.sender === sender) {
    pendingTail.payload += payload
    pendingTail.requests.push({ resolve: resolveRequest })
  } else {
    state.pendingBatches.push({
      handle,
      payload,
      requests: [{ resolve: resolveRequest }],
      sender
    })
  }

  // Why: a send already out under stop-and-wait has no sequence number, so the window only widens once nothing is outstanding.
  state.maxInFlight =
    state.inFlight === 0 ? Math.max(1, maxInFlight) : Math.min(state.maxInFlight, maxInFlight)
  if (!state.current) {
    state.allSent = true
    state.current = new Promise<boolean>((resolve) => {
      state.settleCurrent = resolve
    })
  }
  drainTerminalLiveMirrorSends(state)
  return request
}
