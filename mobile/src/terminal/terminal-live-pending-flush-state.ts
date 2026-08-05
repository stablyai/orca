import { isTerminalLiveInputWithinByteLimit } from './terminal-live-input'

type PendingMirrorSend = {
  batchKey: string
  payload: string
  resolve: (accepted: boolean) => void
  sendMirrorPayload: (payload: string) => Promise<boolean>
}

export type TerminalLivePendingFlushState = {
  current: Promise<boolean> | null
  pending: PendingMirrorSend[]
}

export function createTerminalLivePendingFlushState(): TerminalLivePendingFlushState {
  return { current: null, pending: [] }
}

export function waitForTerminalLivePendingFlush(
  state: TerminalLivePendingFlushState
): Promise<boolean> {
  return state.current ?? Promise.resolve(true)
}

// Why: Relay RTT can exceed the keyboard cadence. Keep the first acknowledged
// RPC in flight, then combine queued erase/append deltas into bounded batches
// without changing their order or making migration delivery ambiguous.
export function queueTerminalLiveMirrorSend(
  state: TerminalLivePendingFlushState,
  batchKey: string,
  payload: string,
  sendMirrorPayload: (payload: string) => Promise<boolean>
): Promise<boolean> {
  const result = new Promise<boolean>((resolve) => {
    state.pending.push({ batchKey, payload, resolve, sendMirrorPayload })
  })
  startTerminalLiveMirrorDrain(state)
  return result
}

function startTerminalLiveMirrorDrain(state: TerminalLivePendingFlushState): void {
  if (state.current) {
    return
  }
  const drain = drainTerminalLiveMirrorSends(state)
  state.current = drain
  void drain.then(() => {
    if (state.current !== drain) {
      return
    }
    state.current = null
    // A send can queue from a promise reaction at the drain boundary. Restart
    // so that item cannot be stranded behind an already-settled current promise.
    if (state.pending.length > 0) {
      startTerminalLiveMirrorDrain(state)
    }
  })
}

async function drainTerminalLiveMirrorSends(
  state: TerminalLivePendingFlushState
): Promise<boolean> {
  let allAccepted = true
  while (state.pending.length > 0) {
    const batch = takeTerminalLiveMirrorBatch(state.pending)
    const accepted = await batch.sendMirrorPayload(batch.payload).catch(() => false)
    allAccepted = accepted && allAccepted
    for (const pending of batch.sends) {
      pending.resolve(accepted)
    }
  }
  return allAccepted
}

function takeTerminalLiveMirrorBatch(pending: PendingMirrorSend[]): {
  payload: string
  sends: PendingMirrorSend[]
  sendMirrorPayload: (payload: string) => Promise<boolean>
} {
  const first = pending.shift()!
  const sends = [first]
  let payload = first.payload
  while (pending.length > 0) {
    const next = pending[0]!
    if (next.batchKey !== first.batchKey) {
      break
    }
    const combined = payload + next.payload
    if (!isTerminalLiveInputWithinByteLimit(combined)) {
      break
    }
    pending.shift()
    sends.push(next)
    payload = combined
  }
  return { payload, sends, sendMirrorPayload: first.sendMirrorPayload }
}
