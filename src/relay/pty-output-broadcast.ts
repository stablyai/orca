import type { IPty } from 'node-pty'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import {
  appendPtyOutput,
  cancelPtyOutputDrains,
  canSendPtyOutput,
  createPtyOutputState,
  ensurePtyOutputClient,
  evictablePtyOutputClientIds,
  hasSendablePtyOutput,
  pendingPtyOutputCharCount,
  PTY_OUTPUT_HIGH_WATER_CHARS,
  relayPtyOutputCharCount,
  removePtyOutputClient,
  resumePtyOutputProducer,
  updatePtyOutputProducer,
  type PtyOutputClientFlow,
  type PtyOutputState,
  type RelayPtyOutput
} from './pty-output-flow-state'

export {
  PTY_OUTPUT_HIGH_WATER_CHARS,
  PTY_OUTPUT_LOW_WATER_CHARS,
  type RelayPtyOutput
} from './pty-output-flow-state'

const PTY_OUTPUT_BATCH_INTERVAL_MS = 8
const PTY_OUTPUT_DRAIN_CONTINUE_MS = 1
const PTY_OUTPUT_FLUSH_MAX_WRITES = 2

export class PtyOutputBroadcast {
  private readonly states = new Map<string, PtyOutputState>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribeClientDetach: (() => void) | null

  constructor(private readonly dispatcher: RelayDispatcher) {
    this.unsubscribeClientDetach = dispatcher.onClientDetached((clientId) => {
      this.detachClient(clientId)
    })
  }

  register(id: string, producer: Pick<IPty, 'pause' | 'resume'>): void {
    this.unregister(id)
    this.states.set(id, createPtyOutputState(id, producer))
  }

  enqueue(id: string, output: RelayPtyOutput, immediate = false): void {
    const state = this.states.get(id)
    if (!state || (output.data.length === 0 && relayPtyOutputCharCount(output) === 0)) {
      return
    }
    const clientIds = this.dispatcher.connectedClientIds()
    if (clientIds.length === 0) {
      return
    }
    for (const clientId of clientIds) {
      ensurePtyOutputClient(state, clientId)
    }
    appendPtyOutput(state, output, new Set(clientIds))
    if (pendingPtyOutputCharCount(state) >= PTY_OUTPUT_HIGH_WATER_CHARS) {
      this.enforceBacklogBound(state)
    } else {
      updatePtyOutputProducer(state)
    }
    if (immediate || output.transformed === true) {
      this.flushState(state, PTY_OUTPUT_FLUSH_MAX_WRITES)
      this.scheduleContinuationIfNeeded()
      return
    }
    this.scheduleFlush(PTY_OUTPUT_BATCH_INTERVAL_MS)
  }

  acknowledge(params: Record<string, unknown>, context: RequestContext): void {
    const id = params.id
    const charCount = params.charCount
    const deliveryToken = params.deliveryToken
    if (
      typeof id !== 'string' ||
      typeof charCount !== 'number' ||
      !Number.isFinite(charCount) ||
      charCount <= 0 ||
      typeof deliveryToken !== 'string'
    ) {
      return
    }
    const state = this.states.get(id)
    const flow = state?.clients.get(context.clientId)
    if (!state || !flow || flow.deliveryToken !== deliveryToken) {
      return
    }
    flow.unackedChars = Math.max(0, flow.unackedChars - Math.floor(charCount))
    this.flushState(state, PTY_OUTPUT_FLUSH_MAX_WRITES)
    this.scheduleContinuationIfNeeded()
  }

  resetClient(id: string, clientId: number): void {
    const state = this.states.get(id)
    if (!state) {
      return
    }
    removePtyOutputClient(state, clientId)
    if (this.dispatcher.connectedClientIds().includes(clientId)) {
      ensurePtyOutputClient(state, clientId)
    }
    updatePtyOutputProducer(state)
    this.clearFlushTimerIfIdle()
  }

  flushForExit(id: string): void {
    const state = this.states.get(id)
    if (!state) {
      return
    }
    // Why bypass normal credit: the bounded final tail must be queued before pty.exit tears down the client-side terminal.
    this.flushState(state, Number.POSITIVE_INFINITY, true)
  }

  unregister(id: string): void {
    const state = this.states.get(id)
    if (!state) {
      return
    }
    resumePtyOutputProducer(state)
    for (const flow of state.clients.values()) {
      cancelPtyOutputDrains(flow)
    }
    state.clients.clear()
    state.pending.length = 0
    this.states.delete(id)
    this.clearFlushTimerIfIdle()
  }

  dispose(): void {
    this.unsubscribeClientDetach?.()
    this.unsubscribeClientDetach = null
    for (const id of Array.from(this.states.keys())) {
      this.unregister(id)
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  private flushPending(): void {
    this.flushTimer = null
    let writesRemaining = PTY_OUTPUT_FLUSH_MAX_WRITES
    for (const state of this.states.values()) {
      if (writesRemaining <= 0) {
        break
      }
      writesRemaining -= this.flushState(state, 1)
    }
    if (this.hasSendablePendingOutput()) {
      this.scheduleFlush(PTY_OUTPUT_DRAIN_CONTINUE_MS)
    }
  }

  private flushState(state: PtyOutputState, maxWrites: number, force = false): number {
    let writes = 0
    const blockedClientIds = new Set<number>()
    for (let entryIndex = 0; entryIndex < state.pending.length; ) {
      if (writes >= maxWrites) {
        break
      }
      const pending = state.pending[entryIndex]
      for (const clientId of Array.from(pending.pendingClientIds)) {
        if (writes >= maxWrites) {
          break
        }
        if (blockedClientIds.has(clientId)) {
          continue
        }
        const flow = state.clients.get(clientId)
        if (!flow) {
          pending.pendingClientIds.delete(clientId)
          continue
        }
        if (!force && !canSendPtyOutput(flow)) {
          blockedClientIds.add(clientId)
          continue
        }
        pending.pendingClientIds.delete(clientId)
        this.sendToClient(state, flow, pending)
        writes++
        if (state.pending[entryIndex] !== pending) {
          break
        }
        if (!force && !canSendPtyOutput(flow)) {
          blockedClientIds.add(clientId)
        }
      }
      if (state.pending[entryIndex] !== pending) {
        continue
      }
      if (pending.pendingClientIds.size === 0) {
        state.pending.splice(entryIndex, 1)
      } else {
        entryIndex++
      }
    }
    if (pendingPtyOutputCharCount(state) >= PTY_OUTPUT_HIGH_WATER_CHARS) {
      this.evictLaggingClientsWhenHealthy(state)
    }
    updatePtyOutputProducer(state)
    this.clearFlushTimerIfIdle()
    return writes
  }

  private sendToClient(
    state: PtyOutputState,
    flow: PtyOutputClientFlow,
    output: RelayPtyOutput
  ): void {
    const result = this.dispatcher.notifyClientWithBackpressure(flow.clientId, 'pty.data', {
      id: state.id,
      data: output.data,
      ...(output.rawLength === undefined ? {} : { rawLength: output.rawLength }),
      ...(output.transformed ? { transformed: true } : {}),
      ...(output.seq === undefined ? {} : { seq: output.seq }),
      deliveryToken: flow.deliveryToken
    })
    if (!result.delivered || state.clients.get(flow.clientId) !== flow) {
      removePtyOutputClient(state, flow.clientId)
      return
    }
    flow.unackedChars += relayPtyOutputCharCount(output)
    if (!result.saturated) {
      return
    }
    flow.sinkBackpressured = true
    if (result.cancelDrain) {
      flow.drainCancellations.add(result.cancelDrain)
    }
    void result.drained.then(() => {
      if (result.cancelDrain) {
        flow.drainCancellations.delete(result.cancelDrain)
      }
      if (state.clients.get(flow.clientId) !== flow) {
        return
      }
      flow.sinkBackpressured = false
      this.flushState(state, PTY_OUTPUT_FLUSH_MAX_WRITES)
      this.scheduleContinuationIfNeeded()
    })
  }

  private detachClient(clientId: number): void {
    for (const state of this.states.values()) {
      removePtyOutputClient(state, clientId)
      updatePtyOutputProducer(state)
    }
    this.clearFlushTimerIfIdle()
  }

  private enforceBacklogBound(state: PtyOutputState): void {
    this.flushState(state, Number.POSITIVE_INFINITY)
    if (pendingPtyOutputCharCount(state) < PTY_OUTPUT_HIGH_WATER_CHARS) {
      return
    }
    this.evictLaggingClientsWhenHealthy(state)
    updatePtyOutputProducer(state)
  }

  private evictLaggingClientsWhenHealthy(state: PtyOutputState): void {
    for (const clientId of evictablePtyOutputClientIds(state)) {
      this.dispatcher.evictClient(clientId)
      this.detachClient(clientId)
    }
  }

  private hasSendablePendingOutput(): boolean {
    return hasSendablePtyOutput(this.states.values())
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer) {
      return
    }
    this.flushTimer = setTimeout(() => this.flushPending(), delayMs)
  }

  private scheduleContinuationIfNeeded(): void {
    if (this.hasSendablePendingOutput()) {
      this.scheduleFlush(PTY_OUTPUT_DRAIN_CONTINUE_MS)
    }
  }

  private clearFlushTimerIfIdle(): void {
    if (
      this.flushTimer === null ||
      Array.from(this.states.values()).some((s) => s.pending.length)
    ) {
      return
    }
    clearTimeout(this.flushTimer)
    this.flushTimer = null
  }
}
