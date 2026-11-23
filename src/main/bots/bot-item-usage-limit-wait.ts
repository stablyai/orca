// An In progress item whose every live worker stopped on its agent's usage limit is Waiting on the
// soonest reset, said in the text; once a worker isn't stopped, Orca's own wait goes back to In
// progress. Driven by the chat host's status feed, the same stops the sidebar shows: no timer.
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

/** A workspace's stopped session: its agent and when its limit resets. */
export type BotUsageLimitCut = { agent: string; resetsAt: number }

/** What an item waits on when every live worker (by workspace) is stopped; null when one isn't, or
 *  none is live. */
export function botItemUsageLimitWaitText(
  liveWorkspaces: readonly (string | null)[],
  cuts: ReadonlyMap<string, BotUsageLimitCut>,
  locale?: string
): string | null {
  const stops = liveWorkspaces.map((id) => (id === null ? undefined : cuts.get(id)))
  if (stops.length === 0 || stops.some((stop) => stop === undefined)) {
    return null
  }
  const soonest = stops.reduce((a, b) => (b!.resetsAt < a!.resetsAt ? b : a))!
  const agent = tuiAgentDisplayName(soonest.agent) ?? soonest.agent
  const when = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(soonest.resetsAt))
  return `${agent} usage resets ${when}`
}

/** Each In progress item of these workspaces' workers whose every live worker is stopped waits on
 *  the soonest reset; one Orca set Waiting so goes back to In progress once one isn't. The moved. */
export async function moveItemsOnUsageLimits(
  store: BotItemsRemote,
  join: Pick<BotItemLinkJoin, 'readLinkedWorkers' | 'linkView'>,
  cuts: ReadonlyMap<string, BotUsageLimitCut>,
  changed: ReadonlySet<string>
): Promise<BotItemRecord[]> {
  const refs = await store.linkedDispatchRefs()
  const workers = await join.readLinkedWorkers(refs)
  const workspaceOf = (ref: string) => workers.get(ref)?.worker?.worktreeId ?? null
  const touched = refs.filter((ref) => changed.has(workspaceOf(ref) ?? ''))
  if (touched.length === 0) {
    return []
  }
  const uids = [...new Set((await store.linksTo('dispatch', touched)).map((l) => l.itemUid))]
  const rows = await store.viewRows(uids)
  const moved: BotItemRecord[] = []
  for (const item of rows.items) {
    if (item.status !== 'working' && item.status !== 'waiting') {
      continue
    }
    const live = (rows.links[item.uid] ?? []).flatMap((link) => {
      const view = link.kind === 'dispatch' ? join.linkView(link, workers.get(link.ref)) : null
      return view?.kind === 'dispatch' && isLiveBotItemWorker(view.state)
        ? [workspaceOf(link.ref)]
        : []
    })
    if ((await store.usageLimitWait(item.uid, botItemUsageLimitWaitText(live, cuts))) !== null) {
      moved.push(item)
    }
  }
  return moved
}

type CutsChanged = (
  cuts: ReadonlyMap<string, BotUsageLimitCut>,
  changed: ReadonlySet<string>
) => Promise<void>

function cutOf(summary: AgentSessionStatusSummary, now: number): BotUsageLimitCut | null {
  const cut = summary.usageLimitContinue
  return cut && usageLimitStopOf(summary, now)
    ? { agent: summary.agent, resetsAt: cut.resetsAt }
    : null
}

/** Follows the host's stopped sessions and hands each change, by workspace, to `changed`. */
export function watchBotItemUsageLimits(changed: CutsChanged): () => void {
  const bySession = new Map<string, { workspaceId: string; cut: BotUsageLimitCut }>()
  const dirty = new Set<string>()
  let running: Promise<void> | null = null
  const flush = (): void => {
    running ??= (async () => {
      while (dirty.size > 0) {
        const workspaces = new Set(dirty)
        dirty.clear()
        const cuts = new Map<string, BotUsageLimitCut>()
        for (const { workspaceId, cut } of bySession.values()) {
          const held = cuts.get(workspaceId)
          if (!held || cut.resetsAt < held.resetsAt) {
            cuts.set(workspaceId, cut)
          }
        }
        await changed(cuts, workspaces).catch((error: unknown) =>
          console.warn('[bots] items: usage-limit wait failed', error)
        )
      }
    })().finally(() => {
      running = null
    })
  }
  const saw = (summary: AgentSessionStatusSummary): void => {
    const before = bySession.get(summary.sessionId)
    const cut = cutOf(summary, Date.now())
    if (before?.cut.resetsAt === cut?.resetsAt && before?.workspaceId === summary.workspaceId) {
      return
    }
    if (before) {
      dirty.add(before.workspaceId)
    }
    if (cut) {
      bySession.set(summary.sessionId, { workspaceId: summary.workspaceId, cut })
      dirty.add(summary.workspaceId)
    } else {
      bySession.delete(summary.sessionId)
    }
  }
  let unwatch: (() => void) | undefined
  const boot = (): void => {
    unwatch?.()
    unwatch = getStructuredAgentSessionHost()?.subscribeStatus({
      id: 'bot-item-usage-limit-waits',
      emit: (event) => {
        if (event.type === 'snapshot') {
          const seen = new Set(event.sessions.map((session) => session.sessionId))
          for (const [sessionId, { workspaceId }] of bySession) {
            if (!seen.has(sessionId)) {
              bySession.delete(sessionId)
              dirty.add(workspaceId)
            }
          }
          event.sessions.forEach(saw)
        } else if (event.type === 'status') {
          saw(event.session)
        }
        if (dirty.size > 0) {
          flush()
        }
      }
    })
  }
  const stop = onStructuredAgentSessionHostChanged(boot)
  boot()
  return () => {
    stop()
    unwatch?.()
  }
}
