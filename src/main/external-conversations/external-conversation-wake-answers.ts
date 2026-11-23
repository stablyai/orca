// Where a chat's self-started turn (a background task's wake-up) answers: the conversation whose own
// turn started the task, by the task's id, kept on the link so a restart still knows.
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { isSelfStartedTurnRow } from '../../shared/agent-session/requests/structured-agent-session-latest-request'
import type { AgentChildWorkView } from '../../shared/agent-status/child-work/agent-status-child-work-view'
import {
  isAgentChildWork,
  isLiveChildWork
} from '../../shared/agent-status/child-work/agent-status-child-work-liveness'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { EndedChatTurn } from './external-conversation-ended-turn'
import type { LinkedConversation } from './external-conversation-links'

type WakeAnswers = ExternalConversationLink['wakeAnswers']
type ChildWork = readonly Pick<
  AgentChildWorkView,
  'id' | 'kind' | 'state' | 'operation' | 'firstObservedAt' | 'observedAt' | 'settledAt'
>[]

/** Kept per link; a chat with more running at once is unusual, and an id over the cap is no one's. */
const MAX_WAKE_TASKS = 16

export type WakeAnswersDeps = {
  /** The chat's child work, settled included; empty when it can't be read. */
  childWork: (sessionId: string) => ChildWork
  /** Keeps (or, with undefined, clears) the tasks whose wake-ups answer the link. */
  keepWakeAnswers: (linked: LinkedConversation, wakeAnswers: WakeAnswers) => void
}

function backgroundTasks(children: ChildWork): ChildWork {
  return children.filter((child) => !isAgentChildWork(child))
}

/** At a turn's end: the tasks its conversation's turns started that still run. A turn that answered
 *  the conversation adds the tasks first seen during it (its end read later may see newer ones); any
 *  other turn, or one someone in Orca steered into, adds none, so a task Orca asked for never answers
 *  the thread. */
export function settleWake(
  deps: WakeAnswersDeps,
  linked: LinkedConversation,
  turn: { answered: boolean; startedAt: number | null; endedAt: number }
): void {
  const tasks = backgroundTasks(deps.childWork(linked.link.sessionId))
  const live = new Set(tasks.filter(isLiveChildWork).map((task) => task.id))
  const { startedAt, endedAt } = turn
  const steered = startedAt !== null && (linked.link.orcaJoinedAt ?? 0) >= startedAt
  const started =
    turn.answered && startedAt !== null && !steered
      ? tasks.filter(
          (task) =>
            live.has(task.id) &&
            task.firstObservedAt >= startedAt &&
            task.firstObservedAt <= endedAt
        )
      : []
  const ids = [
    ...new Set([
      ...(linked.link.wakeAnswers?.tasks ?? []).filter((id) => live.has(id)),
      ...started.map((task) => task.id)
    ])
  ].slice(0, MAX_WAKE_TASKS)
  const next = ids.length > 0 ? { tasks: ids, at: endedAt } : undefined
  if (next || linked.link.wakeAnswers) {
    deps.keepWakeAnswers(linked, next)
  }
}

/** Whether the tasks that finished since the last turn ended, so woke the chat, are all ones its
 *  conversation's turns started. Any other finishing too makes the wake-up Orca's: it can't be told
 *  apart. */
function wokeForConversation(wakeAnswers: WakeAnswers, children: ChildWork): boolean {
  if (!wakeAnswers) {
    return false
  }
  const recorded = new Set(wakeAnswers.tasks)
  const finished = backgroundTasks(children).filter(
    (task) => !isLiveChildWork(task) && (task.settledAt ?? task.observedAt) > wakeAnswers.at
  )
  return finished.length > 0 && finished.every((task) => recorded.has(task.id))
}

/** The ended turn is the chat waking itself for tasks its conversation's turns started. */
export function wokenTurn(
  turn: Pick<EndedChatTurn, 'selfStarted'>,
  link: Pick<ExternalConversationLink, 'wakeAnswers'>,
  children: ChildWork
): boolean {
  return turn.selfStarted === true && wokeForConversation(link.wakeAnswers, children)
}

/** The chat's running turn is such a wake-up: it opened itself, nothing was steered in (a steer
 *  clears the record), and only the conversation's tasks finished since. */
export function wokenRunningTurn(
  link: Pick<ExternalConversationLink, 'wakeAnswers'>,
  activeTurn: { item: Pick<AgentJournalRenderItem, 'itemId' | 'body'> } | null | undefined,
  children: ChildWork
): boolean {
  return Boolean(
    activeTurn &&
    isSelfStartedTurnRow(activeTurn.item, () => false) &&
    wokeForConversation(link.wakeAnswers, children)
  )
}

/** Between turns, whether all that runs is tasks its conversation's turns started, so a worker one of
 *  them starts reports there. With anything else running, the caller can't be told apart. */
export function onlyConversationTasksRun(
  link: Pick<ExternalConversationLink, 'wakeAnswers'>,
  children: ChildWork
): boolean {
  const recorded = new Set(link.wakeAnswers?.tasks ?? [])
  const live = backgroundTasks(children).filter(isLiveChildWork)
  return live.length > 0 && live.every((task) => recorded.has(task.id))
}
