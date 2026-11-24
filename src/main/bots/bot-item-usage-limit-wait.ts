// An In progress item whose every live worker stopped on its agent's usage limit is Waiting on the
// soonest continue, said in the text; once a worker isn't stopped, Orca's own wait goes back to In
// progress. Driven by the chat host's status feed (the same stops the sidebar shows), worker and item
// changes, and the automation scheduler's existing minute tick for a reset that passes unannounced.
import type { AgentSessionStatusSummary } from '../../shared/agent-session/agent-session-wire'
import { tuiAgentDisplayName } from '../../shared/agent-launch/catalog/tui-agent-display-names'
import { isLiveBotItemWorker } from '../../shared/bots/bot-items'
import { usageLimitStopOf } from '../../shared/bots/bot-usage-limit-stop'
import type { BotItemLinkJoin } from './bot-items-link-join'
import type { BotItemsRemote } from './bot-items-ops'
import type { BotItemRecord } from './bot-items-schema'
import {
  getStructuredAgentSessionHost,
  onStructuredAgentSessionHostChanged
} from '../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** A session's stop: its agent, when it ends (Orca's continue, else the reset) and whether Orca
 *  continues it. */
export type BotUsageLimitCut = { agent: string; at: number; auto: boolean }

/** What an item waits on when every live worker (by its session) is stopped; null when one isn't, or
 *  none is live. */
export function botItemUsageLimitWaitText(
  liveSessions: readonly (string | null)[],
  cuts: ReadonlyMap<string, BotUsageLimitCut>,
  locale?: string
): string | null {
  const stops = liveSessions.map((id) => (id === null ? undefined : cuts.get(id)))
  if (stops.length === 0 || stops.some((stop) => stop === undefined)) {
    return null
  }
  const soonest = stops.reduce((a, b) => (b!.at < a!.at ? b : a))!
  const agent = tuiAgentDisplayName(soonest.agent) ?? soonest.agent
  const when = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(soonest.at))
  return soonest.auto ? `${agent} continues ${when}` : `${agent} usage resets ${when}`
}

/** The store calls a pass makes. */
export type BotItemUsageLimitStore = Pick<
  BotItemsRemote,
  'linkedDispatchRefs' | 'linksTo' | 'viewRows' | 'usageLimitWait' | 'usageLimitWaitUids'
>

export type BotItemUsageLimitDeps = {
  /** The profile's items store, only once it has a file. */
  store: () => BotItemUsageLimitStore | null
  join: Pick<BotItemLinkJoin, 'readLinkedWorkers' | 'linkView'>
  /** A worker's (its newest Dispatch's) chat session root; null for one with no chat. */
  sessionOf: (dispatchId: string) => string | null
  /** A chat session's lineage root, which `sessionOf` answers in. */
  root: (sessionId: string) => string
  /** Items Orca moved. */
  changed: (items: readonly BotItemRecord[]) => void
}

/** Each In progress or Waiting item with workers waits or goes back as its workers' stops say.
 *  Report each move even if a later write fails. Return true if a concurrent edit needs a new pass. */
export async function moveItemsOnUsageLimits(
  store: BotItemUsageLimitStore,
  join: BotItemUsageLimitDeps['join'],
  sessionOf: BotItemUsageLimitDeps['sessionOf'],
  cuts: ReadonlyMap<string, BotUsageLimitCut>,
  moved: (items: readonly BotItemRecord[]) => void
): Promise<boolean> {
  const savedWaits = new Set(await store.usageLimitWaitUids())
  const uids = new Set(savedWaits)
  if (cuts.size > 0) {
    const links = await store.linksTo('dispatch', await store.linkedDispatchRefs())
    for (const link of links) {
      uids.add(link.itemUid)
    }
  }
  if (uids.size === 0) {
    return false
  }
  const rows = await store.viewRows([...uids])
  const items = rows.items.filter(
    (item) => item.status === 'working' || (item.status === 'waiting' && savedWaits.has(item.uid))
  )
  const links: typeof rows.links = cuts.size > 0 ? rows.links : {}
  const refs = [
    ...new Set(
      items.flatMap((item) =>
        (links[item.uid] ?? []).flatMap((link) => (link.kind === 'dispatch' ? [link.ref] : []))
      )
    )
  ]
  const workers =
    refs.length > 0 ? await join.readLinkedWorkers(refs, { pullRequests: false }) : new Map()
  const done: BotItemRecord[] = []
  let stale = false
  let failure: unknown = null
  for (const item of items) {
    const live = (links[item.uid] ?? []).flatMap((link) => {
      const read = workers.get(link.ref)
      const view = link.kind === 'dispatch' ? join.linkView(link, read) : null
      return view?.kind === 'dispatch' && isLiveBotItemWorker(view.state)
        ? [sessionOf(read?.worker?.dispatchId ?? link.ref)]
        : []
    })
    const text = botItemUsageLimitWaitText(live, cuts)
    await store.usageLimitWait(item.uid, text, undefined, item.version).then(
      (result) => {
        if (result === 'stale') {
          stale = true
        } else if (result !== null) {
          done.push(item)
        }
      },
      (error: unknown) => (failure ??= error)
    )
  }
  moved(done)
  if (failure !== null) {
    throw failure
  }
  return stale
}

function cutOf(summary: AgentSessionStatusSummary, now: number): BotUsageLimitCut | null {
  const stop = usageLimitStopOf(summary, now)
  return stop ? { agent: summary.agent, at: stop.at, auto: stop.auto } : null
}

/** The host's stopped sessions by root, and the items they move. One pass at a time; a trigger during
 *  one runs it again, and a failed pass is tried again at the next trigger, never in a loop. */
export class BotItemUsageLimitWaits {
  private readonly cuts = new Map<string, BotUsageLimitCut>()
  private readonly summaries = new Map<string, AgentSessionStatusSummary>()
  private running: Promise<void> | null = null
  private again = false
  /** Retry a failed or stale pass on the next trigger, even with no stop left. */
  private retry = false
  private unwatch: (() => void) | null = null

  constructor(private readonly deps: BotItemUsageLimitDeps) {}

  /** Follows the chat host's status feed, the host it is now and any it becomes. */
  start(): void {
    if (this.unwatch) {
      return
    }
    let unsubscribe: (() => void) | undefined
    const boot = (): void => {
      unsubscribe?.()
      unsubscribe = getStructuredAgentSessionHost()?.subscribeStatus({
        id: 'bot-item-usage-limit-waits',
        emit: (event) => this.saw(event)
      })
    }
    const stopHost = onStructuredAgentSessionHostChanged(boot)
    boot()
    this.unwatch = () => {
      stopHost()
      unsubscribe?.()
    }
  }

  stop(): void {
    this.unwatch?.()
    this.unwatch = null
  }

  saw(
    event:
      | { type: 'snapshot'; sessions: AgentSessionStatusSummary[] }
      | { type: 'status'; session: AgentSessionStatusSummary }
      | { type: 'end' },
    now = Date.now()
  ): void {
    if (event.type === 'snapshot') {
      this.summaries.clear()
      event.sessions.forEach((session) => this.summaries.set(session.sessionId, session))
    } else if (event.type === 'status') {
      this.summaries.set(event.session.sessionId, event.session)
    }
    // A snapshot always passes: a wait saved before a restart may outlive every stop.
    this.read(now, event.type === 'snapshot')
  }

  /** A minute passed: a stop whose time has come ends even when its session says nothing new. */
  tick(now = Date.now()): void {
    if (this.cuts.size > 0 || this.retry) {
      this.read(now, this.retry)
    }
  }

  /** A worker or an item changed: while any session is stopped, its items are looked at again. */
  recheck(): void {
    if (this.cuts.size > 0 || this.retry) {
      this.run()
    }
  }

  /** Settles once the passes started so far are done. */
  async settled(): Promise<void> {
    await this.running
  }

  private read(now: number, force = false): void {
    // A lineage's newest session speaks for it: a running continuation clears an older one's stop.
    const newest = new Map<string, AgentSessionStatusSummary>()
    for (const summary of this.summaries.values()) {
      const root = this.deps.root(summary.sessionId)
      const held = newest.get(root)
      if (!held || summary.updatedAt > held.updatedAt) {
        newest.set(root, summary)
      }
    }
    const next = new Map<string, BotUsageLimitCut>()
    for (const [root, summary] of newest) {
      const cut = cutOf(summary, now)
      if (cut) {
        next.set(root, cut)
      }
    }
    const same =
      next.size === this.cuts.size &&
      [...next].every(([root, cut]) => {
        const held = this.cuts.get(root)
        return held?.at === cut.at && held.auto === cut.auto && held.agent === cut.agent
      })
    if (!same || force) {
      this.cuts.clear()
      next.forEach((cut, root) => this.cuts.set(root, cut))
      this.run()
    }
  }

  private run(): void {
    this.again = true
    this.running ??= (async () => {
      while (this.again) {
        this.again = false
        const store = this.deps.store()
        if (!store) {
          return
        }
        this.retry = false
        this.retry = await moveItemsOnUsageLimits(
          store,
          this.deps.join,
          this.deps.sessionOf,
          new Map(this.cuts),
          this.deps.changed
        ).catch((error: unknown) => {
          console.warn('[bots] items: usage-limit wait failed', error)
          return true
        })
      }
    })().finally(() => {
      this.running = null
    })
  }
}
