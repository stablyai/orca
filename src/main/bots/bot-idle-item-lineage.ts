import {
  clearedInto,
  resolveLineageRunningSession,
  type AgentSessionRecordReader
} from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'

export type IdleItemLineageEnd = { id: string; unread?: true } | null
type Subscription = NonNullable<AgentSessionRecordReader['onRecordsChanged']>
type Entry = { end: IdleItemLineageEnd; path: string[]; dirtyFrom: number | null }
type Watched = { next: string | null | undefined; entries: Map<Entry, number> }

/** A missing record is distinct from one the host cannot read. */
export function readIdleItemChat(records: AgentSessionRecordReader, id: string) {
  try {
    if (records.isSessionUnreadable?.(id)) {
      return undefined
    }
    return records.getRecord(id) ?? (records.isSessionUnreadable ? null : undefined)
  } catch {
    return undefined
  }
}

/** Cache live candidates' lineages. A committed change invalidates only the suffix from that edge. */
class IdleItemLineages {
  private readonly bots = new Map<string, Map<string, Entry>>()
  private readonly watched = new Map<string, Watched>()
  private roster: readonly { id: string }[] | undefined

  constructor(records?: AgentSessionRecordReader) {
    if (!records?.lineageRevision) {
      return
    }
    let revision = records.lineageRevision()
    records.onRecordsChanged?.((ids) => {
      const next = records.lineageRevision?.()
      if (!next || next === revision) {
        return
      }
      revision = next
      for (const id of ids) {
        const watched = this.watched.get(id)
        if (watched) {
          const row = readIdleItemChat(records, id)
          this.update(watched, row ? clearedInto(row) : undefined)
        }
      }
    })
  }

  private update(watched: Watched, next: Watched['next']): void {
    if (watched.next !== next) {
      watched.next = next
      for (const [entry, index] of watched.entries) {
        entry.dirtyFrom = Math.min(entry.dirtyFrom ?? index, index)
      }
    }
  }

  private forget(entry: Entry, from = 0): void {
    while (entry.path.length > from) {
      const id = entry.path.pop()!
      const watched = this.watched.get(id)!
      watched.entries.delete(entry)
      if (watched.entries.size === 0) {
        this.watched.delete(id)
      }
    }
  }

  read(
    records: AgentSessionRecordReader,
    botId: string,
    kept: ReadonlySet<string>,
    roster: readonly { id: string }[] | undefined
  ): (root: string, reread?: boolean) => IdleItemLineageEnd {
    if (roster && roster !== this.roster) {
      this.roster = roster
      const live = new Set(roster.map(({ id }) => id))
      for (const [id, ends] of this.bots) {
        if (!live.has(id)) {
          for (const entry of ends.values()) {
            this.forget(entry)
          }
          this.bots.delete(id)
        }
      }
    }
    const ends = this.bots.get(botId) ?? new Map<string, Entry>()
    for (const [root, entry] of ends) {
      if (!kept.has(root)) {
        this.forget(entry)
        ends.delete(root)
      }
    }
    if (kept.size === 0) {
      this.bots.delete(botId)
      return () => null
    }
    this.bots.set(botId, ends)
    return (root, reread) => {
      const cached = ends.get(root)
      if (cached && cached.dirtyFrom === null && !reread) {
        return cached.end
      }
      const entry: Entry = cached ?? { end: null, path: [], dirtyFrom: null }
      const from = entry.dirtyFrom ?? Math.max(0, entry.path.length - 1)
      const start = entry.path[from] ?? root
      this.forget(entry, from)
      entry.dirtyFrom = null
      let unread: string | null = null
      const running = resolveLineageRunningSession(
        {
          getRecord: (id) => {
            const watched = this.watched.get(id) ?? { next: undefined, entries: new Map() }
            // The resolver checks suffix cycles. A link back into the preserved prefix is also a cycle.
            if (watched.entries.has(entry)) {
              return null
            }
            const record = readIdleItemChat(records, id)
            if (!record) {
              unread = id
            }
            this.update(watched, record ? clearedInto(record) : undefined)
            watched.entries.set(entry, entry.path.length)
            entry.path.push(id)
            this.watched.set(id, watched)
            return record ?? null
          }
        },
        start
      )
      entry.end =
        running.kind !== 'unverifiable'
          ? { id: running.sessionId }
          : unread === null
            ? null
            : { id: unread, unread: true }
      ends.set(root, entry)
      return entry.end
    }
  }
}

export function createIdleItemLineageReader() {
  const stores = new WeakMap<Subscription, IdleItemLineages>()
  return (
    records: AgentSessionRecordReader,
    botId: string,
    kept: ReadonlySet<string>,
    roster?: readonly { id: string }[]
  ) => {
    const subscribe = records.onRecordsChanged
    if (!subscribe || !records.lineageRevision) {
      return new IdleItemLineages().read(records, botId, kept, roster)
    }
    let lineages = stores.get(subscribe)
    if (!lineages && kept.size === 0) {
      return () => null
    }
    if (!lineages) {
      lineages = new IdleItemLineages(records)
      stores.set(subscribe, lineages)
    }
    return lineages.read(records, botId, kept, roster)
  }
}
