import type { TerminalInputEnqueueOptions } from '../input-delivery/mobile-terminal-input-owner'
export type TerminalLiveMirrorSender = (
  handle: string,
  payload: string,
  enqueue?: TerminalInputEnqueueOptions
) => Promise<boolean>
export type TerminalLiveInputFailure = 'input-too-large' | 'delivery-unconfirmed'

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
  onFailure: ((handle: string, failure: TerminalLiveInputFailure) => void) | null
  current: Promise<boolean> | null
  cancelCurrent: (() => void) | null
  activeRequests: TerminalLivePendingRequest[]
  generation: number
  controller: AbortController
  waiting: boolean
  settle: ((sent: boolean) => void) | null
  pendingBatches: TerminalLivePendingBatch[]
}

export function createTerminalLivePendingFlushState(): TerminalLivePendingFlushState {
  return {
    onFailure: null,
    current: null,
    cancelCurrent: null,
    activeRequests: [],
    generation: 0,
    controller: new AbortController(),
    waiting: false,
    settle: null,
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
  state.controller.abort()
  state.controller = new AbortController()
  state.waiting = false
  state.settle = null
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

function drainTerminalLiveMirrorSends(state: TerminalLivePendingFlushState): void {
  if (state.waiting) {
    return
  }
  const batch = state.pendingBatches.shift()
  if (!batch) {
    if (!state.activeRequests.length) {
      state.settle?.(true)
      state.current = null
      state.cancelCurrent = null
      state.settle = null
    }
    return
  }
  const generation = state.generation
  state.waiting = true
  state.activeRequests.push(...batch.requests)
  let advanced = false
  const advance = () => {
    if (advanced || state.generation !== generation) {
      return
    }
    advanced = true
    state.waiting = false
    drainTerminalLiveMirrorSends(state)
  }
  const reject = () => {
    if (state.generation !== generation) {
      return
    }
    cancelTerminalLivePendingFlush(state)
    state.onFailure?.(
      batch.handle,
      batch.byteLength > TERMINAL_LIVE_INPUT_MAX_BYTES ? 'input-too-large' : 'delivery-unconfirmed'
    )
  }
  let delivery: Promise<boolean>
  try {
    delivery =
      batch.byteLength > TERMINAL_LIVE_INPUT_MAX_BYTES
        ? Promise.resolve(false)
        : batch.sender(batch.handle, batch.payload, {
            signal: state.controller.signal,
            control: batch.control,
            onAdmission: (accepted) => (accepted ? advance() : reject())
          })
  } catch {
    delivery = Promise.resolve(false)
  }
  void delivery
    .catch(() => false)
    .then((sent) => {
      if (state.generation !== generation) {
        return
      }
      if (!sent) {
        reject()
        return
      }
      const completed = new Set(batch.requests)
      state.activeRequests = state.activeRequests.filter((request) => !completed.has(request))
      batch.requests.forEach(({ resolve }) => resolve(true))
      advance()
      drainTerminalLiveMirrorSends(state)
    })
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
    pendingTail.control === control &&
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
    let resolveBarrier = (_sent: boolean): void => {}
    state.current = new Promise<boolean>((resolve) => {
      resolveBarrier = resolve
    })
    state.settle = resolveBarrier
    state.cancelCurrent = () => resolveBarrier(false)
  }
  drainTerminalLiveMirrorSends(state)
  return request
}
import { getTerminalInputByteLength } from '../../../../src/shared/terminal/input/terminal-input'
import { TERMINAL_LIVE_INPUT_MAX_BYTES } from './terminal-live-input'
