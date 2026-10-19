import type {
  SidebarInputsChangedEvent,
  SidebarInputsReadResult
} from '../../../shared/sidebar-list/sidebar-inputs-feed-contract'
import {
  INITIAL_SIDEBAR_INPUTS_FEED_STATE,
  refreshSidebarInputs,
  sidebarInputsChanged,
  sidebarInputsReplied,
  type SidebarInputsFeedRequest,
  type SidebarInputsFeedState,
  type SidebarInputsFeedStep
} from '../../../shared/sidebar-list/sidebar-inputs-feed-installer'
import type { SidebarInputsFeed, SidebarInputsFeedDomain } from './sidebar-inputs-feed'

/** A domain whose entities a test edits; counts its reads and live watchers. */
export function testDomain(
  name: string,
  initial: Record<string, unknown> = {},
  options: { rereadOnRead?: boolean } = {}
) {
  let entities: Record<string, unknown> = { ...initial }
  const watchers = new Set<() => void>()
  let reads = 0
  let failing = false
  let gate: Promise<void> | null = null
  const domain: SidebarInputsFeedDomain = {
    name,
    rereadOnRead: options.rereadOnRead,
    read: async () => {
      reads += 1
      await gate
      if (failing) {
        throw new Error('read failed')
      }
      return { ...entities }
    },
    watch: (changed) => {
      watchers.add(changed)
      return () => watchers.delete(changed)
    }
  }
  const announce = (): void => watchers.forEach((changed) => changed())
  return {
    domain,
    entities: () => entities,
    set(key: string, value: unknown) {
      entities = { ...entities, [key]: value }
      announce()
    },
    remove(key: string) {
      entities = Object.fromEntries(
        Object.entries(entities).filter(([existing]) => existing !== key)
      )
      announce()
    },
    fail(next: boolean) {
      failing = next
    },
    /** Edits without announcing, as a source with no change event does. */
    setQuietly(key: string, value: unknown) {
      entities = { ...entities, [key]: value }
    },
    /** Holds every read until the returned release runs. */
    hold(): () => void {
      let release = (): void => {}
      gate = new Promise((resolve) => {
        release = () => {
          gate = null
          resolve()
        }
      })
      return release
    },
    reads: () => reads,
    watchers: () => watchers.size
  }
}

/** A phone driving the shared installer against one feed, one reply at a time. */
export class TestPhone {
  state: SidebarInputsFeedState = INITIAL_SIDEBAR_INPUTS_FEED_STATE
  pending: SidebarInputsFeedRequest | null = null
  readonly replies: SidebarInputsReadResult[] = []

  constructor(
    public feed: SidebarInputsFeed,
    readonly connectionId: string
  ) {
    feed.acquire(connectionId)
  }

  private apply(step: SidebarInputsFeedStep): void {
    this.state = step.state
    this.pending = step.request ?? this.pending
  }

  refresh(): void {
    this.apply(refreshSidebarInputs(this.state))
  }

  notice(event: Pick<SidebarInputsChangedEvent, 'generation' | 'revision'>): void {
    this.apply(sidebarInputsChanged(this.state, event))
  }

  /** The host answers the pending read now; the phone sees the answer only when `deliver` runs. */
  async serveOne(): Promise<{ reply: SidebarInputsReadResult; deliver: () => void }> {
    const request = this.pending
    if (!request) {
      throw new Error('no read pending')
    }
    this.pending = null
    const reply = await this.feed.read(request.params)
    return {
      reply,
      deliver: () => {
        this.replies.push(reply)
        this.apply(sidebarInputsReplied(this.state, request.id, reply))
      }
    }
  }

  async answerOne(): Promise<SidebarInputsReadResult> {
    const { reply, deliver } = await this.serveOne()
    deliver()
    return reply
  }

  async settle(): Promise<void> {
    while (this.pending) {
      await this.answerOne()
    }
  }

  /** The connection closed with whatever was in flight; the next ready supersedes it. */
  disconnect(): void {
    this.feed.release(this.connectionId)
    this.pending = null
  }

  view(): Record<string, Record<string, unknown>> {
    const view: Record<string, Record<string, unknown>> = {}
    for (const [name, entities] of this.state.installed?.domains ?? []) {
      if (entities.size > 0) {
        view[name] = Object.fromEntries(entities)
      }
    }
    return view
  }
}

/** What a phone should hold: every non-empty domain's current entities. */
export function truthOf(...domains: ReturnType<typeof testDomain>[]) {
  const truth: Record<string, Record<string, unknown>> = {}
  for (const domain of domains) {
    if (Object.keys(domain.entities()).length > 0) {
      truth[domain.domain.name] = domain.entities()
    }
  }
  return truth
}
