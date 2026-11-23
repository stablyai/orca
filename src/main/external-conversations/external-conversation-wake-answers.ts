// Where a chat's self-started turn (a background task's wake-up) answers: the conversation every run
// the wake-up names was launched for. A run is the conversation's when, at its launch, every input
// its turn had taken was the conversation's (its delivered messages, or runs already its own), as
// the agent's journal recorded at that moment. Kept on the link so a restart still knows. A wake-up
// that names nothing (a scheduled wake-up, an agent that gives no ids) stays in Orca.
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { isSelfStartedTurnRow } from '../../shared/agent-session/requests/structured-agent-session-latest-request'
import type { AgentChildWorkView } from '../../shared/agent-status/child-work/agent-status-child-work-view'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { EndedChatTurn, EndedTurnLaunch } from './external-conversation-ended-turn'
import type { LinkedConversation } from './external-conversation-links'

type WakeAnswers = ExternalConversationLink['wakeAnswers']
type ChildWork = readonly Pick<AgentChildWorkView, 'providerId' | 'invocation'>[]

/** Kept per link, newest last; a run past the cap is no one's, so its wake-up stays in Orca. */
const MAX_WAKE_RUNS = 16

export type WakeAnswersDeps = {
  /** Keeps the runs whose wake-ups answer the link. */
  keepWakeAnswers: (linked: LinkedConversation, wakeAnswers: WakeAnswers) => void
}

/** At a turn's end: the runs it launched for its conversation alone join the link's. */
export function recordLaunches(
  deps: WakeAnswersDeps,
  linked: LinkedConversation,
  launches: readonly EndedTurnLaunch[] | undefined
): void {
  const kept = linked.link.wakeAnswers?.runs ?? []
  const recorded = new Set(kept)
  const added: string[] = []
  for (const launch of launches ?? []) {
    if (!recorded.has(launch.run) && launchedFor(linked.link, launch, recorded)) {
      recorded.add(launch.run)
      added.push(launch.run)
    }
  }
  if (added.length > 0) {
    const runs = [...kept, ...added].slice(-MAX_WAKE_RUNS)
    deps.keepWakeAnswers(linked, { runs })
  }
}

/** Every input the launching turn had taken was the conversation's: a message it delivered, or a
 *  run already its own. A launch with no input is no one's. */
function launchedFor(
  link: ExternalConversationLink,
  launch: EndedTurnLaunch,
  recorded: ReadonlySet<string>
): boolean {
  return (
    launch.sends.length + launch.runs.length > 0 &&
    launch.sends.every(
      (from) => from?.source === link.source && from.externalId === link.externalId
    ) &&
    launch.runs.every((run) => recorded.has(run))
  )
}

/** A prompt raised during a wake-up the conversation owns is its too when the root agent raised it,
 *  or a subagent whose current run is the conversation's; any other subagent's stays in Orca. */
export function promptOfWake(
  link: Pick<ExternalConversationLink, 'wakeAnswers'>,
  agentId: string | undefined,
  children: ChildWork
): boolean {
  if (agentId === undefined) {
    return true
  }
  const run = children.find((child) => child.providerId === agentId)?.invocation.invocationId
  return run !== undefined && (link.wakeAnswers?.runs ?? []).includes(run)
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

/** The chat's running turn is such a wake-up (a message read into it drops its names, so it stops
 *  being one). */
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
