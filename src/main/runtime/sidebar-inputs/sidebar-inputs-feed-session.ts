import type { SidebarInputsFeedDomain } from './sidebar-inputs-feed'
import {
  type SidebarInputsChangedEvent,
  type SidebarInputsReadParams,
  type SidebarInputsReadResult,
  SIDEBAR_INPUTS_PAGE_MAX_BYTES,
  SIDEBAR_INPUTS_PAGE_MIN_BYTES,
  SIDEBAR_INPUTS_SCHEMA_VERSION,
  SIDEBAR_INPUTS_SEMANTICS_VERSION
} from '../../../shared/sidebar-list/sidebar-inputs-feed-contract'
import {
  type FeedChange,
  feedEntityFromJson,
  paginateFeedChanges,
  type FeedEntity
} from './sidebar-inputs-feed-pages'
import { type FeedRevisionChanges, FeedChangeLog } from './sidebar-inputs-feed-log'

import { FeedPins, feedPageToken } from './sidebar-inputs-feed-pins'

// A change after a quiet spell publishes at once; the rest of its burst at most this often.
const FLUSH_COALESCE_MS = 50
export function feedReply(
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

export class FeedSession {
  private readonly published = new Map<string, Map<string, FeedEntity>>()
  private readonly dirty = new Set<string>()
  private readonly dirtyEntities = new Map<string, Set<string>>()
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
      domain.watch((change) =>
        this.invalidate(domain.name, change?.urgent === true, change?.entities)
      )
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

  private invalidate(name: string, urgent: boolean, entities?: readonly string[]): void {
    if (this.disposed) {
      return
    }
    if (entities && this.domains.find((domain) => domain.name === name)?.readEntities) {
      if (!this.dirty.has(name) || this.dirtyEntities.has(name)) {
        const keys = this.dirtyEntities.get(name) ?? new Set<string>()
        for (const key of entities) {
          keys.add(key)
        }
        this.dirtyEntities.set(name, keys)
      }
    } else {
      this.dirtyEntities.delete(name)
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
      const keys = this.dirtyEntities.get(domain.name)
      this.dirtyEntities.delete(domain.name)
      const read = readDomain(domain, keys && [...keys])
      if (!read) {
        // Nothing schedules a retry: the next flush or phone read does, or the producer's announcement.
        this.dirty.add(domain.name)
        if (keys) {
          this.dirtyEntities.set(domain.name, keys)
        }
        continue
      }
      const changed = keys
        ? this.publishEntities(domain.name, read, keys)
        : this.publish(domain.name, read)
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

  private publishEntities(
    name: string,
    read: Map<string, string>,
    keys: ReadonlySet<string>
  ): Map<string, FeedEntity | null> {
    const changed = new Map<string, FeedEntity | null>()
    const published = this.published.get(name) ?? new Map<string, FeedEntity>()
    for (const key of keys) {
      const json = read.get(key)
      const before = published.get(key)
      if (json === before?.json) {
        continue
      }
      if (json === undefined) {
        published.delete(key)
        changed.set(key, null)
      } else {
        const entity = feedEntityFromJson(json)
        published.set(key, entity)
        changed.set(key, entity)
      }
    }
    this.published.set(name, published)
    return changed
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

export function readDomain(
  domain: SidebarInputsFeedDomain,
  keys?: readonly string[]
): Map<string, string> | null {
  try {
    const snapshot = keys && domain.readEntities ? domain.readEntities(keys) : domain.read()
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
