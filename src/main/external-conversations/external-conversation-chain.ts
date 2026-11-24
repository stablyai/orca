import {
  CONNECTOR_REFUSALS,
  refused,
  type ConnectorRefusal,
  type Delivery
} from './external-conversation-types'

type Lane = {
  controller: AbortController
  signal: AbortSignal
  tail: Promise<unknown>
  // Aborted followers settle before the running item, so the tail cannot prove it ended.
  running: Promise<Delivery> | null
}

export function refusalOf(signal: AbortSignal): ConnectorRefusal {
  return CONNECTOR_REFUSALS.find((reason) => reason === signal.reason) ?? 'connectors_disabled'
}

/** Serialize each conversation; cancellation aborts its head and settles queued work without undoing prior writes. */
export class ConversationChain {
  private readonly lanes = new Map<string, Lane>()

  constructor(private readonly signal: AbortSignal) {}

  enqueue(id: string, run: (signal: AbortSignal) => Promise<Delivery>): Promise<Delivery> {
    const lane = this.lanes.get(id) ?? this.openLane(id)
    if (lane.signal.aborted) {
      return Promise.resolve(refused(refusalOf(lane.signal)))
    }
    const previous = lane.tail
    const turn = new Promise<void>((resolve) => {
      const onAbort = (): void => resolve()
      lane.signal.addEventListener('abort', onAbort, { once: true })
      void previous.then(() => {
        lane.signal.removeEventListener('abort', onAbort)
        resolve()
      })
    })
    const result = turn.then(() => {
      if (lane.signal.aborted) {
        return refused(refusalOf(lane.signal))
      }
      const running = run(lane.signal)
      lane.running = running
      return running.finally(() => {
        lane.running = null
        if (lane.signal.aborted && this.lanes.get(id) === lane) {
          this.lanes.delete(id)
        }
      })
    })
    const tail = result.catch(() => undefined)
    lane.tail = tail
    void tail.then(() => {
      if (this.lanes.get(id) === lane && lane.tail === tail && !lane.running) {
        this.lanes.delete(id)
      }
    })
    return result
  }

  /** Resolves true if no running work could publish; laneSignal protects a replacement lane. */
  cancel(id: string, reason: ConnectorRefusal, laneSignal?: AbortSignal): Promise<boolean> | null {
    const lane = this.lanes.get(id)
    if (!lane || (laneSignal && lane.signal !== laneSignal)) {
      return null
    }
    lane.controller.abort(reason)
    if (!lane.running) {
      this.lanes.delete(id)
      return Promise.resolve(true)
    }
    return lane.running.then(
      (delivery) => delivery.outcome === 'refused',
      () => false
    )
  }

  private openLane(id: string): Lane {
    const controller = new AbortController()
    const lane: Lane = {
      controller,
      signal: AbortSignal.any([this.signal, controller.signal]),
      tail: Promise.resolve(),
      running: null
    }
    this.lanes.set(id, lane)
    return lane
  }
}
