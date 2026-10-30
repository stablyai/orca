type TerminalLiveMirrorSender = (handle: string, payload: string) => Promise<boolean>

type TerminalLivePendingRequest = {
  readonly resolve: (sent: boolean) => void
}

type TerminalLivePendingBatch = {
  readonly handle: string
  payload: string
  byteLength: number
  readonly requests: TerminalLivePendingRequest[]
  readonly sender: TerminalLiveMirrorSender
  readonly control: boolean
}

export type TerminalLivePendingFlushState = {
  current: Promise<boolean> | null
  cancelCurrent: (() => void) | null
  activeRequests: TerminalLivePendingRequest[]
  generation: number
  pendingBatches: TerminalLivePendingBatch[]
}

export function createTerminalLivePendingFlushState(): TerminalLivePendingFlushState {
  return {
    current: null,
    cancelCurrent: null,
    activeRequests: [],
    generation: 0,
    pendingBatches: []
  }
}

export function waitForTerminalLivePendingFlush(
  state: TerminalLivePendingFlushState
): Promise<boolean> {
  return state.current ?? Promise.resolve(true)
}

export function cancelTerminalLivePendingFlush(state: TerminalLivePendingFlushState): void {
  state.generation += 1
  state.cancelCurrent?.()
  state.cancelCurrent = null
  const requests = [
    ...state.activeRequests,
    ...state.pendingBatches.flatMap((batch) => batch.requests)
  ]
  state.activeRequests = []
  state.pendingBatches = []
  state.current = null
  requests.forEach(({ resolve }) => resolve(false))
}

async function drainTerminalLiveMirrorSends(
  state: TerminalLivePendingFlushState,
  generation: number
): Promise<boolean> {
  let allSent = true
  while (state.generation === generation) {
    const batch = state.pendingBatches.shift()
    if (!batch) {
      state.current = null
      return allSent
    }

    state.activeRequests = batch.requests
    let sent = false
    // A control after undelivered text could act on the wrong line, e.g. Return running a partial command.
    if (allSent || !batch.control) {
      let delivery: Promise<boolean>
      try {
        delivery = batch.sender(batch.handle, batch.payload)
      } catch {
        delivery = Promise.resolve(false)
      }
      sent = await delivery.catch(() => false)
      if (state.generation !== generation) {
        return false
      }
    }

    state.activeRequests = []
    batch.requests.forEach(({ resolve }) => resolve(sent))
    allSent &&= sent
  }
  return false
}

// Batch ordered PTY mirror bytes to avoid one round trip per keystroke.
export function queueTerminalLiveMirrorSend(
  state: TerminalLivePendingFlushState,
  handle: string,
  payload: string,
  sender: TerminalLiveMirrorSender
): Promise<boolean> {
  return queueTerminalLiveSend(state, handle, payload, sender, false)
}

export function queueTerminalLiveControlSend(
  state: TerminalLivePendingFlushState,
  handle: string,
  bytes: string,
  sender: TerminalLiveMirrorSender
): Promise<boolean> {
  return queueTerminalLiveSend(state, handle, bytes, sender, true)
}

function queueTerminalLiveSend(
  state: TerminalLivePendingFlushState,
  handle: string,
  payload: string,
  sender: TerminalLiveMirrorSender,
  control: boolean
): Promise<boolean> {
  let resolveRequest: (sent: boolean) => void = () => {}
  const request = new Promise<boolean>((resolve) => {
    resolveRequest = resolve
  })
  const byteLength = getTerminalInputByteLength(payload)
  const pendingTail = state.pendingBatches.at(-1)
  // A control never joins a text batch, so it can be skipped when that text fails to arrive.
  if (
    pendingTail?.handle === handle &&
    pendingTail.sender === sender &&
    (!control || pendingTail.control) &&
    pendingTail.byteLength + byteLength <= TERMINAL_LIVE_INPUT_MAX_BYTES
  ) {
    pendingTail.payload += payload
    pendingTail.byteLength += byteLength
    pendingTail.requests.push({ resolve: resolveRequest })
  } else {
    state.pendingBatches.push({
      handle,
      payload,
      byteLength,
      requests: [{ resolve: resolveRequest }],
      sender,
      control
    })
  }

  if (!state.current) {
    const generation = state.generation
    let resolveBarrier = (_sent: boolean): void => {}
    const barrier = new Promise<boolean>((resolve) => {
      resolveBarrier = resolve
    })
    const cancelBarrier = () => resolveBarrier(false)
    state.cancelCurrent = cancelBarrier
    const drain = drainTerminalLiveMirrorSends(state, generation).catch(() => false)
    state.current = barrier
    void drain.then((sent) => {
      resolveBarrier(sent)
      if (state.current === barrier) {
        state.current = null
      }
      if (state.cancelCurrent === cancelBarrier) {
        state.cancelCurrent = null
      }
    })
  }
  return request
}
import { getTerminalInputByteLength } from '../../../src/shared/terminal-input'
import { TERMINAL_LIVE_INPUT_MAX_BYTES } from './terminal-live-input'
