// Where a chat's self-started turn (a background task's wake-up) answers: the conversation whose own
// turn started every task the wake-up names, by provider task id, kept on the link so a restart still
// knows. A wake-up that names nothing (a scheduled wake-up, an agent that gives no ids) stays in Orca.
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { isSelfStartedTurnRow } from '../../shared/agent-session/requests/structured-agent-session-latest-request'
import type { AgentChildWorkView } from '../../shared/agent-status/child-work/agent-status-child-work-view'
import { isLiveChildWork } from '../../shared/agent-status/child-work/agent-status-child-work-liveness'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { EndedChatTurn } from './external-conversation-ended-turn'
import type { LinkedConversation } from './external-conversation-links'

type WakeAnswers = ExternalConversationLink['wakeAnswers']
type ChildWork = readonly Pick<
  AgentChildWorkView,
  'providerId' | 'kind' | 'state' | 'operation' | 'firstObservedAt'
>[]

/** Kept per link; a chat with more running at once is unusual, and an id over the cap is no one's. */
const MAX_WAKE_TASKS = 16

export type WakeAnswersDeps = {
  /** The chat's child work (tasks, subagents, Monitors), settled included; empty when unreadable. */
  childWork: (sessionId: string) => ChildWork
  /** Keeps (or, with undefined, clears) the tasks whose wake-ups answer the link. */
  keepWakeAnswers: (linked: LinkedConversation, wakeAnswers: WakeAnswers) => void
}

/** Whether someone in Orca steered into the turn that began at `startedAt`. */
export function orcaSteered(
  link: Pick<ExternalConversationLink, 'orcaJoinedAt'>,
  startedAt: number | null
): boolean {
  return startedAt !== null && (link.orcaJoinedAt ?? 0) >= startedAt
}

/** At a turn's end: the provider ids of work its conversation's turns started that still runs. A
 *  turn that answered the conversation adds the work first seen during it (its end, read later, may
 *  see newer work); any other turn, or one someone in Orca steered into, adds none. */
export function settleWake(
  deps: WakeAnswersDeps,
  linked: LinkedConversation,
  turn: { answered: boolean; startedAt: number | null; endedAt: number }
): void {
  const children = deps.childWork(linked.link.sessionId)
  const live = new Set(children.filter(isLiveChildWork).flatMap((child) => child.providerId ?? []))
  const { startedAt, endedAt } = turn
  const started =
    turn.answered && startedAt !== null && !orcaSteered(linked.link, startedAt)
      ? children.filter(
          (child) =>
            child.providerId &&
            live.has(child.providerId) &&
            child.firstObservedAt >= startedAt &&
            child.firstObservedAt <= endedAt
        )
      : []
  const ids = [
    ...new Set([
      ...(linked.link.wakeAnswers?.tasks ?? []).filter((id) => live.has(id)),
      ...started.flatMap((child) => child.providerId ?? [])
    ])
  ].slice(0, MAX_WAKE_TASKS)
  const next = ids.length > 0 ? { tasks: ids } : undefined
  if (next || linked.link.wakeAnswers) {
    deps.keepWakeAnswers(linked, next)
  }
}

/** Every task the wake-up names is one its conversation's turns started. */
function namesOnlyConversationTasks(wakeAnswers: WakeAnswers, wokenBy: readonly string[]): boolean {
  const recorded = new Set(wakeAnswers?.tasks ?? [])
  return wokenBy.length > 0 && wokenBy.every((id) => recorded.has(id))
}

/** The ended turn is the chat waking itself for tasks its conversation's turns started, with no one
 *  steering into it. */
export function wokenTurn(
  turn: Pick<EndedChatTurn, 'wake'>,
  link: Pick<ExternalConversationLink, 'wakeAnswers'>
): boolean {
  return (
    turn.wake !== undefined &&
    !turn.wake.steered &&
    namesOnlyConversationTasks(link.wakeAnswers, turn.wake.wokenBy)
  )
}

/** The chat's running turn is such a wake-up (a steer from Orca clears the record, so it stops being
 *  one). */
export function wokenRunningTurn(
  link: Pick<ExternalConversationLink, 'wakeAnswers'>,
  activeTurn: { item: Pick<AgentJournalRenderItem, 'itemId' | 'body'> } | null | undefined
): boolean {
  return Boolean(
    activeTurn &&
    isSelfStartedTurnRow(activeTurn.item, () => false) &&
    namesOnlyConversationTasks(
      link.wakeAnswers,
      readAgentJournalTurn(activeTurn.item.body)?.wokenBy ?? []
    )
  )
}

/** Between turns, whether all that runs (subagents and Monitors too) is work its conversation's
 *  turns started, so a worker one of them starts reports there. Anything else running, or anything
 *  without an id, can't be told apart. */
export function onlyConversationTasksRun(
  link: Pick<ExternalConversationLink, 'wakeAnswers'>,
  children: ChildWork
): boolean {
  const recorded = new Set(link.wakeAnswers?.tasks ?? [])
  const live = children.filter(isLiveChildWork)
  return (
    live.length > 0 &&
    live.every((child) => child.providerId !== undefined && recorded.has(child.providerId))
  )
}
