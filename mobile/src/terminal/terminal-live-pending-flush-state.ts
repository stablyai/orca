import { TERMINAL_LIVE_INPUT_MAX_BYTES } from './terminal-live-input'

type TerminalLiveMirrorSender = (handle: string, payload: string) => Promise<boolean>

type TerminalLivePendingRequest = {
  readonly resolve: (sent: boolean) => void
}

type TerminalLivePendingBatch = {
  readonly handle: string
  payload: string
  bytes: number
  readonly requests: TerminalLivePendingRequest[]
  readonly sender: TerminalLiveMirrorSender
  readonly pipeline: boolean
}

const MAX_PENDING_REQUESTS = 64
const MAX_PENDING_BYTES = 1024 * 1024
const encoder = new TextEncoder()

export type TerminalLivePendingFlushState = {
  current: Promise<boolean> | null
  generation: number
  pendingBatches: TerminalLivePendingBatch[]
  activeBatches: Set<TerminalLivePendingBatch>
  retainedBytes: number
  requestCount: number
  failed: boolean
  finish: ((sent: boolean) => void) | null
}

export function createTerminalLivePendingFlushState(): TerminalLivePendingFlushState {
  return {
    current: null,
    generation: 0,
    pendingBatches: [],
    activeBatches: new Set(),
    retainedBytes: 0,
    requestCount: 0,
    failed: false,
    finish: null
  }
}

export function waitForTerminalLivePendingFlush(
  state: TerminalLivePendingFlushState
): Promise<boolean> {
  return state.failed ? Promise.resolve(false) : (state.current ?? Promise.resolve(true))
}

function releaseBatch(
  state: TerminalLivePendingFlushState,
  batch: TerminalLivePendingBatch,
  sent: boolean
): void {
  state.retainedBytes -= batch.bytes
  state.requestCount -= batch.requests.length
  batch.payload = ''
  batch.requests.splice(0).forEach(({ resolve }) => resolve(sent))
}

function rejectPending(state: TerminalLivePendingFlushState): void {
  for (const batch of state.pendingBatches.splice(0)) {
    releaseBatch(state, batch, false)
  }
}

export function cancelTerminalLivePendingFlush(state: TerminalLivePendingFlushState): void {
  state.generation += 1
  rejectPending(state)
  for (const batch of state.activeBatches) {
    releaseBatch(state, batch, false)
  }
  state.activeBatches.clear()
  state.finish?.(false)
  state.finish = null
  state.current = null
  state.failed = false
}

function pumpMirrorSends(state: TerminalLivePendingFlushState): void {
  if (state.failed) {
    rejectPending(state)
  }
  while (state.pendingBatches.length > 0) {
    const batch = state.pendingBatches[0]
    if (
      [...state.activeBatches].some(
        (active) =>
          !active.pipeline ||
          !batch.pipeline ||
          active.sender !== batch.sender ||
          active.handle !== batch.handle
      )
    ) {
      return
    }
    state.pendingBatches.shift()
    state.activeBatches.add(batch)
    const generation = state.generation
    const settle = (sent: boolean): void => {
      if (state.generation !== generation) {
        return
      }
      state.activeBatches.delete(batch)
      releaseBatch(state, batch, sent)
      state.failed ||= !sent
      pumpMirrorSends(state)
    }
    try {
      void batch.sender(batch.handle, batch.payload).then(settle, () => settle(false))
    } catch {
      settle(false)
    }
    batch.payload = ''
  }
  if (state.activeBatches.size === 0) {
    state.finish?.(!state.failed)
    state.finish = null
    state.current = null
  }
}

// Pipelining changes dispatch timing, never the meaning of an accepted completion.
export function queueTerminalLiveMirrorSend(
  state: TerminalLivePendingFlushState,
  handle: string,
  payload: string,
  sender: TerminalLiveMirrorSender,
  options: { pipeline?: boolean } = {}
): Promise<boolean> {
  if (state.failed) {
    return Promise.resolve(false)
  }
  const bytes =
    payload.length > TERMINAL_LIVE_INPUT_MAX_BYTES ? Infinity : encoder.encode(payload).byteLength
  if (
    bytes > TERMINAL_LIVE_INPUT_MAX_BYTES ||
    state.retainedBytes + bytes > MAX_PENDING_BYTES ||
    state.requestCount >= MAX_PENDING_REQUESTS
  ) {
    state.failed = true
    rejectPending(state)
    return Promise.resolve(false)
  }
  let resolveRequest: (sent: boolean) => void = () => {}
  const request = new Promise<boolean>((resolve) => {
    resolveRequest = resolve
  })
  state.retainedBytes += bytes
  state.requestCount += 1
  const pipeline = options.pipeline === true
  const pendingTail = state.pendingBatches.at(-1)
  if (
    pendingTail?.handle === handle &&
    pendingTail.sender === sender &&
    pendingTail.pipeline === pipeline &&
    pendingTail.bytes + bytes <= TERMINAL_LIVE_INPUT_MAX_BYTES
  ) {
    pendingTail.payload += payload
    pendingTail.bytes += bytes
    pendingTail.requests.push({ resolve: resolveRequest })
  } else {
    state.pendingBatches.push({
      handle,
      payload,
      bytes,
      requests: [{ resolve: resolveRequest }],
      sender,
      pipeline
    })
  }

  if (!state.current) {
    state.current = new Promise<boolean>((resolve) => {
      state.finish = resolve
    })
  }
  pumpMirrorSends(state)
  return request
}
