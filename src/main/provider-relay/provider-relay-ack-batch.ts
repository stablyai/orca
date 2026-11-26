import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import {
  RELAY_ACKS_MAX,
  type ProviderRelayAckPayload
} from '../daemon/protocol/daemon-provider-relay-protocol'
import { jsonProperty } from '../../shared/json-stream/json-value-property'

/** How often streaming relays ack, together: one timer per daemon connection, not one per chat. */
export const RELAY_ACK_CADENCE_MS = 1_000
/** Acks due on one cadence tick settle at different times (each waits on its journal); they go together. */
const BATCH_WINDOW_MS = 25
const RELAY_REQUEST_TIMEOUT_MS = 10_000

type QueuedAck = {
  payload: ProviderRelayAckPayload
  resolve: (reply: unknown) => void
  reject: (error: Error) => void
}

/** One daemon connection's acks: due on a shared cadence and sent as one request per batch. */
export class ProviderRelayAckBatch {
  private readonly due = new Set<() => void>()
  private cadence: ReturnType<typeof setTimeout> | null = null
  private queued: QueuedAck[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly client: DaemonClient) {}

  /** Runs `run` on the next shared tick; the returned function takes it back. */
  schedule(run: () => void): () => void {
    this.due.add(run)
    if (!this.cadence) {
      this.cadence = setTimeout(() => {
        this.cadence = null
        const runs = [...this.due]
        this.due.clear()
        runs.forEach((due) => due())
      }, RELAY_ACK_CADENCE_MS)
      this.cadence.unref?.()
    }
    return () => {
      this.due.delete(run)
      if (this.due.size === 0 && this.cadence) {
        clearTimeout(this.cadence)
        this.cadence = null
      }
    }
  }

  ack(payload: ProviderRelayAckPayload): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.queued.push({ payload, resolve, reject })
      this.flushTimer ??= setTimeout(() => this.flush(), BATCH_WINDOW_MS)
    })
  }

  private flush(): void {
    this.flushTimer = null
    const batch = this.queued
    this.queued = []
    // A daemon without `relayAcks` takes each on its own, still on the one shared tick.
    if (batch.length === 1 || !this.client.getDaemonIdentity()?.providerRelayAcks) {
      for (const { payload, resolve, reject } of batch) {
        this.client.request('relayAck', payload, RELAY_REQUEST_TIMEOUT_MS).then(resolve, reject)
      }
      return
    }
    // The daemon refuses a whole request past its batch limit, so a large batch goes in parts.
    for (let at = 0; at < batch.length; at += RELAY_ACKS_MAX) {
      this.send(batch.slice(at, at + RELAY_ACKS_MAX))
    }
  }

  private send(batch: QueuedAck[]): void {
    const acks = batch.map(({ payload }) => payload)
    this.client.request('relayAcks', { acks }, RELAY_REQUEST_TIMEOUT_MS).then(
      (reply) => {
        const results = jsonProperty(reply, 'results')
        batch.forEach(({ resolve, reject }, at) => {
          const result: unknown = Array.isArray(results) ? results[at] : undefined
          const error = jsonProperty(result, 'error')
          if (result === undefined || typeof error === 'string') {
            reject(new Error(typeof error === 'string' ? error : 'Relay ack unanswered'))
          } else {
            resolve(result)
          }
        })
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error))
        batch.forEach(({ reject }) => reject(failure))
      }
    )
  }
}
