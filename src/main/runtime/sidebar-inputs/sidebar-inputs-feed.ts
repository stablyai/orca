import { randomUUID } from 'node:crypto'
import {
  SIDEBAR_INPUTS_PAGE_MAX_BYTES,
  SIDEBAR_INPUTS_PAGE_MIN_BYTES,
  SIDEBAR_INPUTS_SCHEMA_VERSION,
  SIDEBAR_INPUTS_SEMANTICS_VERSION,
  type SidebarInputsChangedEvent,
  type SidebarInputsReadParams,
  type SidebarInputsReadResult
} from '../../../shared/sidebar-list/sidebar-inputs-feed-contract'
import {
  feedEntityFromJson,
  paginateFeedChanges,
  type FeedChange,
  type FeedEntity
} from './sidebar-inputs-feed-pages'
import { FeedChangeLog, type FeedRevisionChanges } from './sidebar-inputs-feed-log'
import { FeedPins, feedPageToken } from './sidebar-inputs-feed-pins'

/** An urgent change (an accepted command, a metadata write) publishes with no coalesce delay. */
export type SidebarInputsFeedChange = { urgent?: boolean }

/** Read producer caches synchronously so publishing never waits on scans; null means unavailable until the producer announces readiness. */
export type SidebarInputsFeedDomain = {
  name: string
  read: () => Record<string, unknown> | null
  /** Calls `changed` whenever anything `read` depends on is written; returns the detach. */
  watch: (changed: (change?: SidebarInputsFeedChange) => void) => () => void
  /** Settles once `read` has a first snapshot; only a phone read waits on it. */
  ready?: () => Promise<void>
}

// A change after a quiet spell publishes at once; the rest of its burst at most this often.
const FLUSH_COALESCE_MS = 50

/** Cache/diff/pin phone sidebar inputs only while subscribed; producers continue independently for desktop readers. */
export class SidebarInputsFeed {
  readonly generation = randomUUID()
  private lastRevision = 0
  private readonly subscribers = new Set<string>()
  private session: FeedSession | null = null

  constructor(
    private readonly domains: () => readonly SidebarInputsFeedDomain[],
    private readonly emit: (event: SidebarInputsChangedEvent) => void
  ) {}

  get subscribed(): boolean {
    return this.session !== null
  }

  /** True when `subscriberId` was not yet subscribed, so its caller owns the matching release. */
  acquire(subscriberId: string): boolean {
    if (this.subscribers.has(subscriberId)) {
      return false
    }
    this.subscribers.add(subscriberId)
    // The empty set is a revision of its own, so a cursor from before this session reads afresh.
    this.session ??= new FeedSession(
      this.domains(),
      this.generation,
      this.lastRevision + 1,
      this.emit
    )
    return true
  }

  release(subscriberId: string): void {
    if (this.subscribers.delete(subscriberId) && this.subscribers.size === 0 && this.session) {
      this.lastRevision = this.session.dispose()
      this.session = null
    }
  }

  async read(params: SidebarInputsReadParams): Promise<SidebarInputsReadResult> {
    const session = this.session
    if (!session) {
      throw new Error('sidebar inputs feed has no subscriber')
    }
    return session.read(params)
  }
}

function feedReply(
  generation: string,
  kind: SidebarInputsReadResult['kind'],
  revision: number,
  from: number | null,
  domains: SidebarInputsReadResult['domains'],
  next: string | null
): SidebarInputsReadResult {
  return {
    generation,
    revision,
    schemaVersion: SIDEBAR_INPUTS_SCHEMA_VERSION,
    semanticsVersion: SIDEBAR_INPUTS_SEMANTICS_VERSION,
    kind,
    from,
    domains,
    next
  }
}

class FeedSession {
  private readonly published = new Map<string, Map<string, FeedEntity>>()
  private readonly dirty = new Set<string>()
  private readonly log: FeedChangeLog
  private readonly pins = new FeedPins()
  private readonly detaches: (() => void)[]
  private timer: ReturnType<typeof setTimeout> | null = null
  private urgentQueued = false
  private lastFlushAt = Number.NEGATIVE_INFINITY
  private disposed = false

  constructor(
    private readonly domains: readonly SidebarInputsFeedDomain[],
    private readonly generation: string,
    private revision: number,
    private readonly emit: (event: SidebarInputsChangedEvent) => void
  ) {
    this.log = new FeedChangeLog(revision)
    for (const domain of domains) {
      this.dirty.add(domain.name)
    }
    this.detaches = domains.map((domain) =>
      domain.watch((change) => this.invalidate(domain.name, change?.urgent === true))
    )
  }

  /** Returns the last revision, which the next session continues from. */
  dispose(): number {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
    }
    for (const detach of this.detaches) {
      detach()
    }
    return this.revision
  }

  async read(params: SidebarInputsReadParams): Promise<SidebarInputsReadResult> {
    const { generation } = this
    const reset = (): SidebarInputsReadResult =>
      feedReply(generation, 'reset', this.revision, null, {}, null)
    if (params.pageToken !== undefined) {
      return this.pins.page(params.pageToken) ?? reset()
    }
    // Only a producer's first snapshot is waited on; after that every read serves the cache.
    await Promise.all(this.domains.flatMap((domain) => (domain.ready ? [domain.ready()] : [])))
    // A release during the wait discarded what this read would serve.
    if (this.disposed) {
      return reset()
    }
    // A failed or not-yet-ready read left its domain dirty; this retries it.
    this.flush()
    const budget = Math.min(
      SIDEBAR_INPUTS_PAGE_MAX_BYTES,
      Math.max(SIDEBAR_INPUTS_PAGE_MIN_BYTES, params.maxBytes)
    )
    const { cursor } = params
    // Generations have no order: any other one, or a cursor the log no longer reaches, reads afresh.
    if (
      params.generation === generation &&
      cursor !== undefined &&
      this.log.covers(cursor, this.revision)
    ) {
      return this.batch(`delta:${cursor}`, cursor, budget, () => this.log.since(cursor))
    }
    return this.batch('snapshot', null, budget, () => this.everything())
  }

  private invalidate(name: string, urgent: boolean): void {
    if (this.disposed) {
      return
    }
    this.dirty.add(name)
    if (urgent) {
      // A microtask, not now: the writer announcing this may be mid-change.
      if (!this.urgentQueued) {
        this.urgentQueued = true
        queueMicrotask(() => {
          this.urgentQueued = false
          this.flush()
        })
      }
      return
    }
    this.timer ??= setTimeout(
      () => {
        this.timer = null
        this.flush()
      },
      Math.max(0, this.lastFlushAt + FLUSH_COALESCE_MS - performance.now())
    )
  }

  /** Publishes every dirty domain's cached snapshot as one revision; reads nothing asynchronous. */
  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.disposed) {
      return
    }
    this.lastFlushAt = performance.now()
    const due = this.domains.filter((domain) => this.dirty.has(domain.name))
    this.dirty.clear()
    const changes: FeedRevisionChanges = new Map()
    for (const domain of due) {
      const read = readDomain(domain)
      if (!read) {
        // Nothing schedules a retry: the next flush or phone read does, or the producer's announcement.
        this.dirty.add(domain.name)
        continue
      }
      const changed = this.publish(domain.name, read)
      if (changed.size > 0) {
        changes.set(domain.name, changed)
      }
    }
    if (changes.size > 0) {
      this.revision += 1
      this.log.append(this.revision, changes)
      this.emit({
        type: 'sidebarInputsChanged',
        generation: this.generation,
        revision: this.revision
      })
    }
  }

  /** Replaces a domain's published entities; returns what changed. */
  private publish(name: string, read: Map<string, string>): Map<string, FeedEntity | null> {
    const changed = new Map<string, FeedEntity | null>()
    const before = this.published.get(name) ?? new Map<string, FeedEntity>()
    const after = new Map<string, FeedEntity>()
    for (const [key, json] of read) {
      const kept = before.get(key)
      if (kept?.json === json) {
        after.set(key, kept)
      } else {
        // Parsed from its own JSON, so a producer's later in-place edit cannot reach a page.
        const entity = feedEntityFromJson(json)
        after.set(key, entity)
        changed.set(key, entity)
      }
    }
    for (const key of before.keys()) {
      if (!after.has(key)) {
        changed.set(key, null)
      }
    }
    this.published.set(name, after)
    return changed
  }

  private *everything(): Iterable<FeedChange> {
    for (const domain of this.domains) {
      for (const [key, entity] of this.published.get(domain.name) ?? []) {
        yield [domain.name, key, entity]
      }
    }
  }

  /** The batch at this revision, pinned for its later pages; a reader at the same place shares it. */
  private batch(
    startsFrom: string,
    from: number | null,
    budget: number,
    changes: () => Iterable<FeedChange>
  ): SidebarInputsReadResult {
    const key = `${startsFrom}:${this.revision}:${budget}`
    const pinned = this.pins.find(key)
    if (pinned) {
      return pinned[0]
    }
    const bodies = paginateFeedChanges(changes(), budget)
    const pages = bodies.map((body, index) =>
      feedReply(
        this.generation,
        from === null ? 'snapshot' : 'delta',
        this.revision,
        from,
        body.domains,
        index + 1 < bodies.length ? feedPageToken(key, index + 1) : null
      )
    )
    if (pages.length > 1) {
      this.pins.add(
        key,
        pages,
        bodies.reduce((sum, body) => sum + body.bytes, 0)
      )
    }
    return pages[0]
  }
}

/** Each entity's JSON; null when the read failed or the producer has no snapshot yet. */
function readDomain(domain: SidebarInputsFeedDomain): Map<string, string> | null {
  try {
    const snapshot = domain.read()
    if (!snapshot) {
      return null
    }
    const entities = new Map<string, string>()
    for (const [key, value] of Object.entries(snapshot)) {
      // What JSON cannot hold (undefined, a function) is absent, as it would be on the wire.
      const json: string | undefined = JSON.stringify(value)
      if (json !== undefined) {
        entities.set(key, json)
      }
    }
    return entities
  } catch (error) {
    // The domain keeps what it last published; the next flush or phone read tries again.
    console.warn(`[sidebar-inputs-feed] could not read ${domain.name}`, error)
    return null
  }
}
