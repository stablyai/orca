import { randomUUID } from 'node:crypto'
import type { IPty } from 'node-pty'

export const PTY_OUTPUT_HIGH_WATER_CHARS = 256 * 1024
export const PTY_OUTPUT_LOW_WATER_CHARS = 32 * 1024

const PTY_OUTPUT_FLUSH_CHUNK_CHARS = 16 * 1024

export type RelayPtyOutput = {
  data: string
  rawLength?: number
  transformed?: boolean
  seq?: number
}

export type PtyOutputClientFlow = {
  clientId: number
  deliveryToken: string
  unackedChars: number
  sinkBackpressured: boolean
  drainCancellations: Set<() => void>
}

export type PendingPtyOutput = RelayPtyOutput & {
  pendingClientIds: Set<number>
}

export type PtyOutputState = {
  id: string
  producer: Pick<IPty, 'pause' | 'resume'>
  clients: Map<number, PtyOutputClientFlow>
  pending: PendingPtyOutput[]
  producerPaused: boolean
}

export function createPtyOutputState(
  id: string,
  producer: Pick<IPty, 'pause' | 'resume'>
): PtyOutputState {
  return { id, producer, clients: new Map(), pending: [], producerPaused: false }
}

export function relayPtyOutputCharCount(output: RelayPtyOutput): number {
  return typeof output.rawLength === 'number' && Number.isFinite(output.rawLength)
    ? Math.max(0, Math.floor(output.rawLength))
    : output.data.length
}

function setsEqual(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  if (left.size !== right.size) {
    return false
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false
    }
  }
  return true
}

function appendChunk(
  state: PtyOutputState,
  output: RelayPtyOutput,
  pendingClientIds: Set<number>
): void {
  const tail = state.pending.at(-1)
  const tailChars = tail ? relayPtyOutputCharCount(tail) : 0
  const addedChars = relayPtyOutputCharCount(output)
  if (
    tail &&
    tail.transformed === output.transformed &&
    setsEqual(tail.pendingClientIds, pendingClientIds) &&
    tailChars + addedChars <= PTY_OUTPUT_FLUSH_CHUNK_CHARS
  ) {
    const previousLength = tail.data.length
    tail.data += output.data
    if (tail.rawLength !== undefined || output.rawLength !== undefined) {
      tail.rawLength = (tail.rawLength ?? previousLength) + addedChars
    }
    if (output.seq !== undefined) {
      tail.seq = output.seq
    }
    return
  }
  state.pending.push({ ...output, pendingClientIds })
}

export function appendPtyOutput(
  state: PtyOutputState,
  output: RelayPtyOutput,
  pendingClientIds: Set<number>
): void {
  if (output.transformed || output.data.length <= PTY_OUTPUT_FLUSH_CHUNK_CHARS) {
    appendChunk(state, output, pendingClientIds)
    return
  }
  for (let offset = 0; offset < output.data.length; offset += PTY_OUTPUT_FLUSH_CHUNK_CHARS) {
    const data = output.data.slice(offset, offset + PTY_OUTPUT_FLUSH_CHUNK_CHARS)
    const remainingChars = output.data.length - offset - data.length
    appendChunk(
      state,
      {
        data,
        ...(output.rawLength === undefined ? {} : { rawLength: data.length }),
        ...(output.seq === undefined ? {} : { seq: output.seq - remainingChars })
      },
      new Set(pendingClientIds)
    )
  }
}

export function ensurePtyOutputClient(
  state: PtyOutputState,
  clientId: number
): PtyOutputClientFlow {
  const existing = state.clients.get(clientId)
  if (existing) {
    return existing
  }
  const flow: PtyOutputClientFlow = {
    clientId,
    deliveryToken: randomUUID(),
    unackedChars: 0,
    sinkBackpressured: false,
    drainCancellations: new Set()
  }
  state.clients.set(clientId, flow)
  return flow
}

export function cancelPtyOutputDrains(flow: PtyOutputClientFlow): void {
  for (const cancel of flow.drainCancellations) {
    cancel()
  }
  flow.drainCancellations.clear()
}

export function removePtyOutputClient(state: PtyOutputState, clientId: number): void {
  const flow = state.clients.get(clientId)
  if (flow) {
    cancelPtyOutputDrains(flow)
    state.clients.delete(clientId)
  }
  for (let index = state.pending.length - 1; index >= 0; index--) {
    const pending = state.pending[index]
    pending.pendingClientIds.delete(clientId)
    if (pending.pendingClientIds.size === 0) {
      state.pending.splice(index, 1)
    }
  }
}

export function canSendPtyOutput(flow: PtyOutputClientFlow): boolean {
  return !flow.sinkBackpressured && flow.unackedChars < PTY_OUTPUT_HIGH_WATER_CHARS
}

export function pendingPtyOutputCharCount(state: PtyOutputState, clientId?: number): number {
  return state.pending.reduce(
    (total, pending) =>
      total +
      (clientId === undefined || pending.pendingClientIds.has(clientId)
        ? relayPtyOutputCharCount(pending)
        : 0),
    0
  )
}

export function resumePtyOutputProducer(state: PtyOutputState): void {
  if (!state.producerPaused) {
    return
  }
  try {
    state.producer.resume()
  } catch {
    /* PTY already destroyed */
  }
  state.producerPaused = false
}

export function updatePtyOutputProducer(state: PtyOutputState): void {
  const flows = Array.from(state.clients.values())
  if (flows.length === 0) {
    resumePtyOutputProducer(state)
    return
  }
  if (flows.every((flow) => !canSendPtyOutput(flow))) {
    if (!state.producerPaused) {
      try {
        state.producer.pause()
        state.producerPaused = true
      } catch {
        /* PTY already destroyed */
      }
    }
    return
  }
  if (
    state.producerPaused &&
    flows.some(
      (flow) =>
        !flow.sinkBackpressured &&
        flow.unackedChars + pendingPtyOutputCharCount(state, flow.clientId) <=
          PTY_OUTPUT_LOW_WATER_CHARS
    )
  ) {
    resumePtyOutputProducer(state)
  }
}

export function hasSendablePtyOutput(states: Iterable<PtyOutputState>): boolean {
  for (const state of states) {
    for (const pending of state.pending) {
      for (const clientId of pending.pendingClientIds) {
        const flow = state.clients.get(clientId)
        if (flow && canSendPtyOutput(flow)) {
          return true
        }
      }
    }
  }
  return false
}

export function evictablePtyOutputClientIds(state: PtyOutputState): number[] {
  const laggingClientIds = new Set<number>()
  for (const pending of state.pending) {
    for (const clientId of pending.pendingClientIds) {
      laggingClientIds.add(clientId)
    }
  }
  if (
    laggingClientIds.size === 0 ||
    !Array.from(state.clients.values()).some(
      (flow) => !laggingClientIds.has(flow.clientId) && canSendPtyOutput(flow)
    )
  ) {
    return []
  }
  return Array.from(laggingClientIds)
}
