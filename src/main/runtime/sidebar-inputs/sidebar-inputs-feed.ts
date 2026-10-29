import type {
  SidebarInputsChangedEvent,
  SidebarInputsReadParams,
  SidebarInputsReadResult
} from '../../../shared/sidebar-list/sidebar-inputs-feed-contract'

import { FeedSession } from './sidebar-inputs-feed-session'
import { randomUUID } from 'node:crypto'

/** An urgent change (an accepted command, a metadata write) publishes with no coalesce delay. */
export type SidebarInputsFeedChange = { urgent?: boolean; entities?: readonly string[] }

/** Read producer caches synchronously so publishing never waits on scans; null means unavailable until the producer announces readiness. */
export type SidebarInputsFeedDomain = {
  name: string
  read: () => Record<string, unknown> | null
  readEntities?: (keys: readonly string[]) => Record<string, unknown> | null
  /** Calls `changed` whenever anything `read` depends on is written; returns the detach. */
  watch: (changed: (change?: SidebarInputsFeedChange) => void) => () => void
  /** Settles once `read` has a first snapshot; only a phone read waits on it. */
  ready?: () => Promise<void>
}

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

/** Each entity's JSON; null when the read failed or the producer has no snapshot yet. */
