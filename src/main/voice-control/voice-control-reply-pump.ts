import type { MessageRow, MessageType } from '../runtime/orchestration/types'
import type { MessageWaitResult } from '../runtime/runtime-message-waiters'

/**
 * Long-poll loop on the control's run mailbox: waitForMessage wakes on routed mail (push,
 * no polling), then one FIFO delivery batch is read and acked. Carries worker_done reports
 * from the agents the coordinator kicked off; the coordinator-mail trigger rewrites
 * anything addressed to the control handle onto this same mailbox.
 */

export type ControlMailboxMessage = {
  id: string
  fromHandle: string
  type: string
  subject: string
  body: string
  /** The sender's pane, recorded on the row — the direct route back to a roster entry. */
  senderPaneKey: string | null
  /** Correlation back to the dispatch that owns the reply, when it came from one. */
  dispatchId: string | null
}

export type VoiceControlReplyPumpDeps = {
  waitForMessage: (
    handle: string,
    options: {
      typeFilter?: string[]
      timeoutMs?: number
      signal?: AbortSignal
      exclusive?: boolean
    }
  ) => Promise<MessageWaitResult>
  getRunConsumerGeneration: (runId: string) => number | null
  getRunDelivery: (params: {
    runId: string
    consumerGeneration: number
    wakeTypes?: MessageType[]
  }) => { delivery: { id: string }; messages: MessageRow[] } | undefined
  acknowledgeRunDelivery: (params: {
    runId: string
    consumerGeneration: number
    deliveryId: string
  }) => unknown
  onMessages: (messages: ControlMailboxMessage[]) => void
}

/** What wakes the pump; heartbeat chatter never reaches the user's ear. */
export const CONTROL_WAKE_TYPES: MessageType[] = [
  'worker_done',
  'status',
  'escalation',
  'question',
  'merge_ready'
]

const WAIT_SLICE_MS = 30_000

export class VoiceControlReplyPump {
  private readonly abort = new AbortController()
  private running = false

  constructor(
    private readonly deps: VoiceControlReplyPumpDeps,
    private readonly runId: string
  ) {}

  start(): void {
    if (this.running) {
      return
    }
    this.running = true
    void this.loop()
  }

  stop(): void {
    this.abort.abort()
  }

  private async loop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      const result = await this.deps.waitForMessage(`run:${this.runId}`, {
        typeFilter: CONTROL_WAKE_TYPES,
        timeoutMs: WAIT_SLICE_MS,
        signal: this.abort.signal,
        // One pump per run mailbox; a stuck prior waiter must not double-consume.
        exclusive: true
      })
      if (result === 'cancelled') {
        return
      }
      if (result === 'notified') {
        this.drain()
      }
    }
  }

  /** Reads and acks the current delivery batch; idempotent against empty mailboxes. */
  drain(): void {
    const generation = this.deps.getRunConsumerGeneration(this.runId)
    if (generation === null) {
      return
    }
    const batch = this.deps.getRunDelivery({
      runId: this.runId,
      consumerGeneration: generation,
      wakeTypes: CONTROL_WAKE_TYPES
    })
    if (!batch) {
      return
    }
    const messages = batch.messages.map(toControlMessage).filter((m) => m.body.length > 0)
    this.deps.acknowledgeRunDelivery({
      runId: this.runId,
      consumerGeneration: generation,
      deliveryId: batch.delivery.id
    })
    if (messages.length > 0) {
      this.deps.onMessages(messages)
    }
  }
}

function toControlMessage(row: MessageRow): ControlMailboxMessage {
  return {
    id: row.id,
    fromHandle: row.from_handle,
    type: row.type,
    subject: row.subject,
    body: row.body,
    senderPaneKey: row.sender_pane_key,
    dispatchId: readDispatchId(row.payload)
  }
}

function readDispatchId(payload: string | null): string | null {
  if (!payload) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    if (typeof parsed === 'object' && parsed !== null && 'dispatchId' in parsed) {
      const value = parsed.dispatchId
      return typeof value === 'string' ? value : null
    }
    return null
  } catch {
    return null
  }
}
