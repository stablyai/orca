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

export type BotItemUsageLimitDeps = {
  /** The profile's items store, only once it has a file. */
  store: () => BotItemsRemote | null
  join: Pick<BotItemLinkJoin, 'readLinkedWorkers' | 'linkView'>
  /** A worker's (its newest Dispatch's) chat session root; null for one with no chat. */
  sessionOf: (dispatchId: string) => string | null
  /** A chat session's lineage root, which `sessionOf` answers in. */
  root: (sessionId: string) => string
  /** Items Orca moved. */
  changed: (items: readonly BotItemRecord[]) => void
}

/** Each In progress or Waiting item with workers waits or goes back as its workers' stops say.
 *  `moved` is told of each item moved, even when a later one fails, which then rejects the whole. */
export async function moveItemsOnUsageLimits(
  store: BotItemsRemote,
  join: BotItemUsageLimitDeps['join'],
  sessionOf: BotItemUsageLimitDeps['sessionOf'],
  cuts: ReadonlyMap<string, BotUsageLimitCut>,
  moved: (items: readonly BotItemRecord[]) => void
): Promise<void> {
  const refs = await store.linkedDispatchRefs()
  if (refs.length === 0) {
    return
  }
  const workers = await join.readLinkedWorkers(refs)
  const uids = [...new Set((await store.linksTo('dispatch', refs)).map((link) => link.itemUid))]
  const rows = await store.viewRows(uids)
  const done: BotItemRecord[] = []
  let failure: unknown = null
  for (const item of rows.items) {
    if (item.status !== 'working' && item.status !== 'waiting') {
      continue
    }
    const live = (rows.links[item.uid] ?? []).flatMap((link) => {
      const read = workers.get(link.ref)
      const view = link.kind === 'dispatch' ? join.linkView(link, read) : null
      return view?.kind === 'dispatch' && isLiveBotItemWorker(view.state)
        ? [sessionOf(read?.worker?.dispatchId ?? link.ref)]
        : []
    })
    const text = botItemUsageLimitWaitText(live, cuts)
    await store.usageLimitWait(item.uid, text).then(
      (eventId) => eventId !== null && done.push(item),
      (error: unknown) => (failure ??= error)
    )
  }
  moved(done)
  if (failure !== null) {
    throw failure
  }
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
    this.read(now)
  }

  /** A minute passed: a stop whose time has come ends even when its session says nothing new. */
  tick(now = Date.now()): void {
    if (this.cuts.size > 0) {
      this.read(now)
    }
  }

  /** A worker or an item changed: while any session is stopped, its items are looked at again. */
  recheck(): void {
    if (this.cuts.size > 0) {
      this.run()
    }
  }

  /** Settles once the passes started so far are done. */
  async settled(): Promise<void> {
    await this.running
  }

  private read(now: number): void {
    const next = new Map<string, BotUsageLimitCut>()
    for (const summary of this.summaries.values()) {
      const cut = cutOf(summary, now)
      const root = this.deps.root(summary.sessionId)
      const held = next.get(root)
      if (cut && (!held || cut.at < held.at)) {
        next.set(root, cut)
      }
    }
    const same =
      next.size === this.cuts.size &&
      [...next].every(([root, cut]) => {
        const held = this.cuts.get(root)
        return held?.at === cut.at && held.auto === cut.auto && held.agent === cut.agent
      })
    if (!same) {
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
        await moveItemsOnUsageLimits(
          store,
          this.deps.join,
          this.deps.sessionOf,
          new Map(this.cuts),
          this.deps.changed
        ).catch((error: unknown) => console.warn('[bots] items: usage-limit wait failed', error))
      }
    })().finally(() => {
      this.running = null
    })
  }
}
