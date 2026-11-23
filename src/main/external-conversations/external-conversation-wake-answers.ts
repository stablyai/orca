// Where a chat's self-started turn (a background task's wake-up) answers: the conversation whose
// turn left that work running, kept on the link so a restart still knows.
import { createHash } from 'node:crypto'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { isSelfStartedTurnRow } from '../../shared/agent-session/requests/structured-agent-session-latest-request'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { EndedChatTurn } from './external-conversation-ended-turn'
import type { LinkedConversation } from './external-conversation-links'

type WakeAnswers = ExternalConversationLink['wakeAnswers']

export type WakeAnswersDeps = {
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  /** Keeps (or, with undefined, clears) the background work whose wake-up answers the link. */
  keepWakeAnswers: (linked: LinkedConversation, wakeAnswers: WakeAnswers) => void
}

/** At a turn's end: what it left running answers its conversation only if the turn did. */
export function settleWake(
  deps: WakeAnswersDeps,
  linked: LinkedConversation,
  answered: boolean,
  at: number
): void {
  const work = pendingWork(deps.readHookRow(linked.link.paneKey))
  const next = wakeAnswersAfter(linked.link, answered, work, at)
  if (next !== linked.link.wakeAnswers) {
    deps.keepWakeAnswers(linked, next)
  }
}

/** The ended turn is the chat waking itself for work one of its conversation's turns left running. */
export function wokenTurn(
  turn: Pick<EndedChatTurn, 'selfStarted'>,
  link: Pick<ExternalConversationLink, 'wakeAnswers' | 'lastTurn'>
): boolean {
  return turn.selfStarted === true && wakeAnswersConversation(link)
}

/** What the chat's ended turn left running, fingerprinted; null when nothing does. */
function pendingWork(row: AgentStatusIpcPayload | null): string | null {
  const commands = row?.workingMode === 'monitoring' ? row.backgroundCommands : undefined
  if (!commands?.length) {
    return null
  }
  return createHash('sha256')
    .update(JSON.stringify([...commands].sort()))
    .digest('hex')
    .slice(0, 16)
}

/** The record a turn's end leaves. A turn that answered its conversation hands it the work it left
 *  running. Any other turn keeps an earlier record only while exactly that work still runs: once
 *  other work runs, Orca can't tell whose wake-up comes next, so it stays in Orca. */
function wakeAnswersAfter(
  link: Pick<ExternalConversationLink, 'wakeAnswers'>,
  answered: boolean,
  work: string | null,
  at: number
): WakeAnswers {
  if (!work) {
    return undefined
  }
  if (answered) {
    return { at, work }
  }
  return link.wakeAnswers?.work === work ? link.wakeAnswers : undefined
}

/** Whether a self-started turn answers its conversation: the work that woke it was left by one of the
 *  conversation's turns, or, with none recorded, no one else has asked the chat anything since. */
function wakeAnswersConversation(
  link: Pick<ExternalConversationLink, 'wakeAnswers' | 'lastTurn'>
): boolean {
  return link.wakeAnswers !== undefined || link.lastTurn === 'conversation'
}

/** Whether what the chat runs now acts for its conversation through a wake-up: between turns, only
 *  work a conversation's turn left runs (so a worker it starts reports there); in a turn, the one that
 *  work woke. */
export function wokenForConversation(
  link: Pick<ExternalConversationLink, 'wakeAnswers' | 'lastTurn'>,
  activeTurn: { item: Pick<AgentJournalRenderItem, 'itemId' | 'body'> } | null | undefined
): boolean {
  if (!activeTurn) {
    return link.wakeAnswers !== undefined
  }
  return isSelfStartedTurnRow(activeTurn.item, () => false) && wakeAnswersConversation(link)
}
