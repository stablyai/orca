import {
  MAX_PTY_ACK_ENTRIES,
  type PtySourceCreditAckBatch
} from '../../shared/pty-source-credit-contract'
import type { SshPtySourceAckPublication } from './ssh-pty-source-obligation-contract'

export const SSH_PTY_ACK_FLUSH_MS = 8
export const SSH_PTY_ACK_EAGER_ADVANCE_SU = 64 * 1024
const ACK_PUBLICATION_WATERMARK_LIMIT = 1024

type AckSettlement = { ok: true } | { ok: false; error: Error }

type CoalescedEntry = {
  publication: SshPtySourceAckPublication
  members: SshPtySourceAckPublication[]
}

type InFlightBatch = {
  entries: CoalescedEntry[]
  settled: boolean
}

export type SshPtySourceAckCoalescerOptions = {
  publish: (
    providerGeneration: number,
    batch: PtySourceCreditAckBatch,
    onSettled: (result: AckSettlement) => void
  ) => void
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void
  onTokenClosed?: (identity: SshPtySourceAckPublication['identity']) => void
}

function ackKey(publication: SshPtySourceAckPublication): string {
  const { identity } = publication
  return `${identity.providerGeneration}\0${identity.clientGeneration}\0${identity.ownerGeneration}\0${identity.id}\0${identity.ptyIncarnation}\0${identity.deliveryToken}`
}

export class SshPtySourceAckCoalescer {
  private readonly pending = new Map<string, CoalescedEntry>()
  private readonly lastPublishedEndByToken = new Map<string, number>()
  private readonly schedule: NonNullable<SshPtySourceAckCoalescerOptions['schedule']>
  private readonly cancelSchedule: NonNullable<SshPtySourceAckCoalescerOptions['cancelSchedule']>
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerDelayMs: number | null = null
  private inFlight: InFlightBatch | null = null
  private disposed = false

  constructor(private readonly options: SshPtySourceAckCoalescerOptions) {
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.cancelSchedule = options.cancelSchedule ?? clearTimeout
  }

  enqueue(publication: SshPtySourceAckPublication): void {
    if (this.disposed) {
      publication.onSettled({ ok: false, error: new Error('SSH PTY ACK coalescer disposed') })
      return
    }
    const key = ackKey(publication)
    const current = this.pending.get(key)
    if (!current) {
      this.pending.set(key, { publication, members: [publication] })
    } else {
      current.members.push(publication)
      if (publication.ack.creditedEndSu > current.publication.ack.creditedEndSu) {
        current.publication = publication
      }
    }
    const lastPublished = this.lastPublishedEndByToken.get(key) ?? 0
    const eager = publication.ack.creditedEndSu - lastPublished >= SSH_PTY_ACK_EAGER_ADVANCE_SU
    this.requestFlush(eager ? 0 : SSH_PTY_ACK_FLUSH_MS)
  }

  flush(): void {
    if (this.disposed || this.inFlight || this.pending.size === 0) {
      return
    }
    if (this.timer) {
      this.cancelSchedule(this.timer)
      this.timer = null
      this.timerDelayMs = null
    }
    const providerGeneration = this.pending.values().next().value!.publication
      .identity.providerGeneration
    const selected = Array.from(this.pending.entries())
      .filter(([, entry]) => entry.publication.identity.providerGeneration === providerGeneration)
      .slice(0, MAX_PTY_ACK_ENTRIES)
    for (const [key] of selected) {
      this.pending.delete(key)
    }
    const batch: InFlightBatch = {
      entries: selected.map(([, entry]) => entry),
      settled: false
    }
    this.inFlight = batch
    const settle = (result: AckSettlement): void => this.settleBatch(batch, result)
    try {
      this.options.publish(
        providerGeneration,
        Object.freeze({
          acknowledgements: Object.freeze(batch.entries.map((entry) => entry.publication.ack))
        }),
        settle
      )
    } catch (error) {
      settle({
        ok: false,
        error: error instanceof Error ? error : new Error(String(error))
      })
    }
  }

  dispose(reason = 'SSH PTY ACK coalescer disposed'): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    if (this.timer) {
      this.cancelSchedule(this.timer)
      this.timer = null
      this.timerDelayMs = null
    }
    const result = { ok: false as const, error: new Error(reason) }
    for (const entry of this.pending.values()) {
      this.settleMembers(entry, result)
    }
    this.pending.clear()
    if (this.inFlight && !this.inFlight.settled) {
      const batch = this.inFlight
      batch.settled = true
      this.inFlight = null
      for (const entry of batch.entries) {
        this.settleMembers(entry, result)
      }
    }
  }

  cancelGeneration(providerGeneration: number, reason: string): void {
    const result = { ok: false as const, error: new Error(reason) }
    for (const [key, entry] of this.pending) {
      if (entry.publication.identity.providerGeneration === providerGeneration) {
        this.pending.delete(key)
        this.settleMembers(entry, result)
      }
    }
    const batch = this.inFlight
    if (batch && !batch.settled) {
      const retained: CoalescedEntry[] = []
      for (const entry of batch.entries) {
        if (entry.publication.identity.providerGeneration === providerGeneration) {
          this.settleMembers(entry, result)
        } else {
          retained.push(entry)
        }
      }
      batch.entries = retained
      if (retained.length === 0) {
        batch.settled = true
        this.inFlight = null
      }
    }
    const prefix = `${providerGeneration}\0`
    for (const key of this.lastPublishedEndByToken.keys()) {
      if (key.startsWith(prefix)) {
        this.lastPublishedEndByToken.delete(key)
      }
    }
    if (!this.inFlight && this.pending.size === 0 && this.timer) {
      this.cancelSchedule(this.timer)
      this.timer = null
      this.timerDelayMs = null
    } else if (!this.inFlight && this.pending.size > 0) {
      this.requestFlush(0)
    }
  }

  get pendingCount(): number {
    return this.pending.size
  }

  private settleBatch(batch: InFlightBatch, result: AckSettlement): void {
    if (batch.settled) {
      return
    }
    batch.settled = true
    if (this.inFlight === batch) {
      this.inFlight = null
    }
    for (const entry of batch.entries) {
      if (result.ok) {
        const key = ackKey(entry.publication)
        this.lastPublishedEndByToken.delete(key)
        this.lastPublishedEndByToken.set(key, entry.publication.ack.creditedEndSu)
        while (this.lastPublishedEndByToken.size > ACK_PUBLICATION_WATERMARK_LIMIT) {
          this.lastPublishedEndByToken.delete(this.lastPublishedEndByToken.keys().next().value!)
        }
      }
      this.settleMembers(entry, result)
    }
    if (this.pending.size > 0) {
      this.requestFlush(0)
    }
  }

  private settleMembers(entry: CoalescedEntry, result: AckSettlement): void {
    for (const publication of entry.members.splice(0)) {
      publication.onSettled(result)
    }
  }

  private requestFlush(delayMs: number): void {
    if (this.inFlight || this.disposed) {
      return
    }
    if (this.timer) {
      if (this.timerDelayMs !== null && this.timerDelayMs <= delayMs) {
        return
      }
      this.cancelSchedule(this.timer)
      this.timer = null
    }
    this.timerDelayMs = delayMs
    this.timer = this.schedule(() => {
      this.timer = null
      this.timerDelayMs = null
      this.flush()
    }, delayMs)
    this.timer.unref?.()
  }
}
