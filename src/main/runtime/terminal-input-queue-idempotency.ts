const DEFAULT_MAX_TERMINAL_INPUT_QUEUES = 4_096
const TERMINAL_INPUT_QUEUE_IDLE_TTL_MS = 24 * 60 * 60 * 1_000
const TERMINAL_INPUT_QUEUE_PROTOCOL_ERRORS = new Set([
  'terminal_input_queue_payload_conflict',
  'terminal_input_queue_sequence_gap',
  'terminal_input_queue_sequence_stale'
])

type TerminalInputQueueOperation<T> = {
  readonly sequence: number
  readonly fingerprint: string
  readonly result: Promise<T>
}

type TerminalInputQueueState<T> = {
  nextSequence: number
  current: TerminalInputQueueOperation<T> | null
  last: TerminalInputQueueOperation<T> | null
  touchedAt: number
}

export class TerminalInputQueueIdempotency {
  private readonly queues = new Map<string, TerminalInputQueueState<unknown>>()

  constructor(
    private readonly maxQueues = DEFAULT_MAX_TERMINAL_INPUT_QUEUES,
    private readonly now: () => number = Date.now
  ) {}

  run<T>(
    clientIdentity: string,
    queueId: string,
    sequence: number,
    fingerprint: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = `${clientIdentity}\0${queueId}`
    const state = this.getOrCreateQueue<T>(key, sequence)
    state.touchedAt = this.now()

    const existing =
      state.current?.sequence === sequence
        ? state.current
        : state.last?.sequence === sequence
          ? state.last
          : null
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new Error('terminal_input_queue_payload_conflict'))
      }
      return existing.result
    }
    if (sequence !== state.nextSequence) {
      const reason =
        sequence < state.nextSequence
          ? 'terminal_input_queue_sequence_stale'
          : 'terminal_input_queue_sequence_gap'
      return Promise.reject(new Error(reason))
    }

    let result: Promise<T>
    try {
      result = operation()
    } catch (error) {
      result = Promise.reject(error)
    }
    const queued = { sequence, fingerprint, result }
    state.current = queued
    const settle = (): void => {
      if (state.current !== queued) {
        return
      }
      state.current = null
      state.last = queued
      state.nextSequence += 1
      state.touchedAt = this.now()
    }
    void result.then(settle, settle)
    return result
  }

  private getOrCreateQueue<T>(key: string, firstSequence: number): TerminalInputQueueState<T> {
    const existing = this.queues.get(key)
    if (existing) {
      return existing as TerminalInputQueueState<T>
    }
    if (this.queues.size >= this.maxQueues) {
      this.pruneExpiredQueues()
    }
    if (this.queues.size >= this.maxQueues) {
      throw new Error('terminal_input_queue_capacity_exceeded')
    }
    const created: TerminalInputQueueState<T> = {
      // Why: the mobile logical client survives physical reconnects, while a
      // restarted host loses this in-memory table and first sees a later retry.
      nextSequence: firstSequence,
      current: null,
      last: null,
      touchedAt: this.now()
    }
    this.queues.set(key, created as TerminalInputQueueState<unknown>)
    return created
  }

  private pruneExpiredQueues(): void {
    const expiredBefore = this.now() - TERMINAL_INPUT_QUEUE_IDLE_TTL_MS
    for (const [key, state] of this.queues) {
      if (!state.current && state.touchedAt < expiredBefore) {
        this.queues.delete(key)
      }
    }
  }
}

export function isTerminalInputQueueProtocolError(error: unknown): boolean {
  return error instanceof Error && TERMINAL_INPUT_QUEUE_PROTOCOL_ERRORS.has(error.message)
}
