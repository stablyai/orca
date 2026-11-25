import {
  clearedInto,
  resolveLineageRunningSession,
  type AgentSessionRecordReader
} from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'

export type IdleItemLineageEnd = { id: string; unread?: true } | null
type Subscription = NonNullable<AgentSessionRecordReader['onRecordsChanged']>
type Entry = { end: IdleItemLineageEnd; path: string[]; stale: boolean }
type Watched = { next: string | null | undefined; entries: Set<Entry> }

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

/** Cache only the lineages of live candidates. Committed changes invalidate the paths they touch. */
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
      for (const entry of watched.entries) {
        entry.stale = true
      }
    }
  }

  private forget(entry: Entry): void {
    for (const id of entry.path) {
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
      if (cached && !cached.stale && !reread) {
        return cached.end
      }
      if (cached) {
        this.forget(cached)
      }
      let unread: string | null = null
      const entry: Entry = { end: null, path: [], stale: false }
      const running = resolveLineageRunningSession(
        {
          getRecord: (id) => {
            const record = readIdleItemChat(records, id)
            if (!record) {
              unread = id
            }
            entry.path.push(id)
            const next = record ? clearedInto(record) : undefined
            const watched = this.watched.get(id) ?? { next, entries: new Set<Entry>() }
            this.update(watched, next)
            watched.entries.add(entry)
            this.watched.set(id, watched)
            return record ?? null
          }
        },
        root
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
