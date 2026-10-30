import { z } from 'zod'
import type { OrchestrationDb } from './db'
import type { StructuredPointerTarget } from './structured-mailbox-pointer-delivery'
export type MailAdmission = { owner: object; generation: string; queuedBytes: number }
export const sourceIdentity = z.object({
  id: z.string(),
  run_id: z.string(),
  sequence: z.number(),
  type: z.string(),
  to_handle: z.string(),
  read: z.number(),
  delivered_at: z.string().nullable(),
  pointer_enter_pending: z.number(),
  delivery_contract: z.string(),
  ordering_origin: z.enum(['local', 'imported']).nullable()
})
export type SourceIdentity = z.infer<typeof sourceIdentity>
export const SOURCE_COLUMNS = `id, run_id, sequence, type, to_handle, read, delivered_at,
  pointer_enter_pending, delivery_contract, ordering_origin`
export type Debt = 'capacity' | 'check' | 'stable' | 'retry' | 'stamp'
export const sourceState = (source: SourceIdentity): string =>
  JSON.stringify([
    source.run_id,
    source.to_handle,
    source.type,
    source.read,
    source.delivered_at,
    source.pointer_enter_pending,
    source.delivery_contract,
    source.ordering_origin
  ])
export class MailDebts extends Map<
  string,
  { sequence: number; reason: Debt; type: string; state: string }
> {
  private readonly reasons = new Map<Debt, Map<string, Set<string>>>()
  override set(
    id: string,
    value: { sequence: number; reason: Debt; type: string; state: string }
  ): this {
    this.delete(id)
    const types = this.reasons.get(value.reason) ?? new Map<string, Set<string>>()
    this.reasons.set(value.reason, types)
    const ids = types.get(value.type) ?? new Set<string>()
    types.set(value.type, ids)
    ids.add(id)
    return super.set(id, value)
  }
  override delete(id: string): boolean {
    const previous = this.get(id)
    if (previous) {
      const types = this.reasons.get(previous.reason)
      const ids = types?.get(previous.type)
      ids?.delete(id)
      if (!ids?.size) {
        types?.delete(previous.type)
      }
      if (!types?.size) {
        this.reasons.delete(previous.reason)
      }
    }
    return super.delete(id)
  }
  select(reason: Debt, filter?: ReadonlySet<string>): string[] {
    const types = this.reasons.get(reason)
    if (!types) {
      return []
    }
    const ids: string[] = []
    for (const type of filter ?? types.keys()) {
      for (const id of types.get(type) ?? []) {
        ids.push(id)
      }
    }
    return ids.sort((a, b) => (this.get(a)?.sequence ?? 0) - (this.get(b)?.sequence ?? 0))
  }
}
export class MailPending extends Map<string, number> {
  private revision = 0
  constructor(private readonly membership?: (id: string, present: boolean) => void) {
    super()
  }
  override set(id: string, revision: number): this {
    this.membership?.(id, true)
    return super.set(id, revision)
  }
  override delete(id: string): boolean {
    const removed = super.delete(id)
    if (removed) {
      this.membership?.(id, false)
    }
    return removed
  }
  nominate(id: string): void {
    this.set(id, ++this.revision)
  }
  include(id: string): void {
    if (!this.has(id)) {
      this.nominate(id)
    }
  }
}
export type Interest = {
  db: OrchestrationDb
  target: StructuredPointerTarget
  authority: MailAdmission
  frontier: number
  deferred: MailDebts
  dirty: MailPending
  running: boolean
  pending: boolean
  consumersChanged: boolean
  consumerTypes?: Set<string>
  capacityImproved: boolean
  retry: boolean
  authorityChanged: boolean
}

/** One finite metadata pass; creation and lifecycle remain with the existing adapter/queue. */
export async function discoverMailSources(input: {
  mailbox: string
  interest: Interest
  current: () => boolean
  admission: () => MailAdmission | null
  offer: (source: SourceIdentity) => Promise<void>
  retire: (id: string) => void
  finished: () => void
}): Promise<void> {
  const { mailbox, interest, current, admission, offer, retire, finished } = input
  while (interest.pending && current()) {
    interest.pending = false
    const now = admission()
    if (!now) {
      return
    }
    const improved = interest.capacityImproved || now.queuedBytes < interest.authority.queuedBytes
    interest.capacityImproved = false
    const consumersChanged = interest.consumersChanged
    const retry = interest.retry
    interest.consumersChanged = false
    interest.retry = false
    interest.authority = now
    const selected = new Set(interest.dirty.keys())
    const select = (reason: Debt, filter?: ReadonlySet<string>) => {
      for (const id of interest.deferred.select(reason, filter)) {
        selected.add(id)
        interest.dirty.include(id)
      }
    }
    if (improved) {
      select('capacity')
    }
    if (consumersChanged) {
      select('check', interest.consumerTypes)
    }
    interest.consumerTypes = undefined
    if (retry) {
      select('retry')
      select('stamp')
    }
    if (interest.authorityChanged) {
      interest.authorityChanged = false
      select('stable')
      select('retry')
      select('check')
    }
    for (const id of selected) {
      const raw = interest.db.db
        .prepare(`SELECT ${SOURCE_COLUMNS} FROM messages WHERE id = ?`)
        .get(id)
      if (!raw) {
        retire(id)
      } else {
        await offer(sourceIdentity.parse(raw))
      }
      if (!current()) {
        return
      }
    }
    const through = Number(
      interest.db.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS high FROM messages').get()
        ?.high ?? 0
    )
    while (interest.frontier < through && current()) {
      const rows = interest.db.db
        .prepare(`SELECT ${SOURCE_COLUMNS} FROM messages
          WHERE to_handle = ? AND delivered_at IS NULL AND sequence > ? AND sequence <= ?
          ORDER BY sequence LIMIT 50`)
        .all(mailbox, interest.frontier, through)
      if (rows.length === 0) {
        interest.frontier = through
        break
      }
      for (const raw of rows) {
        const source = sourceIdentity.parse(raw)
        if (!selected.has(source.id)) {
          interest.dirty.include(source.id)
          await offer(source)
        }
        if (!current()) {
          return
        }
        interest.frontier = source.sequence
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const capacity = admission()
    if (capacity) {
      // Our own inserts reduce capacity, never an improvement that replays refused debt.
      interest.authority = capacity
    }
    if (!interest.pending && interest.deferred.size === 0 && current()) {
      finished()
    }
  }
}
