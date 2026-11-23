// Where a chat's self-started turn (a background task's wake-up) answers: the conversation whose own
// turn started every run the wake-up names, by the run's id (the call that started it; a resumed task
// gets a new one), kept on the link so a restart still knows. A wake-up that names nothing (a
// scheduled wake-up, an agent that gives no ids) stays in Orca.
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
  'invocation' | 'kind' | 'state' | 'operation' | 'firstObservedAt'
>[]

/** Kept per link; a chat with more running at once is unusual, and an id over the cap is no one's. */
const MAX_WAKE_RUNS = 16

export type WakeAnswersDeps = {
  /** The chat's child work (tasks, subagents, Monitors), settled included; empty when unreadable. */
  childWork: (sessionId: string) => ChildWork
  /** Keeps (or, with undefined, clears) the runs whose wake-ups answer the link. */
  keepWakeAnswers: (linked: LinkedConversation, wakeAnswers: WakeAnswers) => void
}

/** Whether someone in Orca steered into the turn that began at `startedAt`. */
export function orcaSteered(
  link: Pick<ExternalConversationLink, 'orcaJoinedAt'>,
  startedAt: number | null
): boolean {
  return startedAt !== null && (link.orcaJoinedAt ?? 0) >= startedAt
}

/** At a turn's end: the runs its conversation's turns started that still run. A turn that answered
 *  the conversation adds the runs first seen during it (its end, read later, may see newer ones); any
 *  other turn, or one someone in Orca steered into, adds none. A resumed task is a new run, so a
 *  resume from Orca drops the thread's claim on it. */
export function settleWake(
  deps: WakeAnswersDeps,
  linked: LinkedConversation,
  turn: { answered: boolean; startedAt: number | null; endedAt: number }
): void {
  const children = deps.childWork(linked.link.sessionId)
  const live = children.filter(isLiveChildWork)
  const liveRuns = new Set(live.map((child) => child.invocation.invocationId))
  const { startedAt, endedAt } = turn
  const started =
    turn.answered && startedAt !== null && !orcaSteered(linked.link, startedAt)
      ? live.filter(
          (child) => child.firstObservedAt >= startedAt && child.firstObservedAt <= endedAt
        )
      : []
  const kept = linked.link.wakeAnswers?.runs ?? []
  const runs = [
    ...new Set([
      ...kept.filter((id) => liveRuns.has(id)),
      ...started.map((child) => child.invocation.invocationId)
    ])
  ].slice(0, MAX_WAKE_RUNS)
  if (runs.length === kept.length && runs.every((id, index) => id === kept[index])) {
    return
  }
  deps.keepWakeAnswers(linked, runs.length > 0 ? { runs } : undefined)
}

/** Every run the wake-up names is one its conversation's turns started. */
function namesOnlyConversationTasks(wakeAnswers: WakeAnswers, wokenBy: readonly string[]): boolean {
  const recorded = new Set(wakeAnswers?.runs ?? [])
  return wokenBy.length > 0 && wokenBy.every((id) => recorded.has(id))
}

/** The ended turn is the chat waking itself for runs its conversation's turns started, with no one
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
