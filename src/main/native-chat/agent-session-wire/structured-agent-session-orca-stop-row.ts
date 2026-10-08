// The row that says why a quit or update cut a reply: the cut turn's own explanation, in the words
// every client already prints for a stopped agent, with the cause beside them for clients that
// name it (`AgentSessionOrcaStop`).

import {
  agentSessionHostStatusBody,
  agentSessionResponseInterruptedStoredBody
} from '../../../shared/agent-session-host-status-rows'
import { isAgentSessionOrcaStopCause } from '../../../shared/agent-session-orca-stop'
import type { AgentSessionResumeTrigger } from '../../../shared/agent-session-resume-marker'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import type {
  AgentJournalRenderItem,
  AgentJournalStatusItem
} from '../../../shared/agent-session-journal-types'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session-turn-record'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import { orcaShutdownRowClientMessageId } from '../../../shared/native-chat-orca-stop-cut'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

type OrcaStopRowJournal = Pick<AgentSessionJournal, 'snapshot' | 'appendItem'>

/** The row about an owner gone from under a turn: words that blame no one, stored red so an older
 *  client keeps it on screen, and why Orca stopped when it was Orca, which a client that knows the
 *  cause names instead, muted. */
export function orcaStopRowBody(orcaEnd: unknown): AgentJournalStatusItem {
  return isAgentSessionOrcaStopCause(orcaEnd)
    ? { ...agentSessionHostStatusBody('orca-stop'), tone: 'error', orcaStop: { cause: orcaEnd } }
    : agentSessionResponseInterruptedStoredBody()
}

/** The root turn running as the quit stops the child: the one its stop may cut. */
export function runningRootTurnItemId(
  journal: Pick<AgentSessionJournal, 'snapshot'>
): string | null {
  return (
    journal
      .snapshot()
      .items.findLast(
        (item) =>
          isRootAgentJournalItem(item) && readAgentJournalTurn(item.body)?.state === 'running'
      )?.itemId ?? null
  )
}

function cutByNobody(item: AgentJournalRenderItem | undefined): boolean {
  const turn = item ? readAgentJournalTurn(item.body) : null
  return (
    turn !== null &&
    agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) }) ===
      'interruption'
  )
}

/**
 * Once the quit's stop has settled: when the turn running at the stop now reads cut with nobody
 * asking (not finished, not a person's Stop), say why. Never throws: a row that cannot be written
 * must not keep the quit from releasing the chat.
 */
export async function recordStructuredAgentSessionShutdownCut(input: {
  journal: OrcaStopRowJournal
  sessionId: string
  fence: number
  generation: string
  turnItemId: string | null
  trigger: AgentSessionResumeTrigger
  logger: StructuredAgentSessionLogger
}): Promise<void> {
  try {
    const { turnItemId } = input
    if (turnItemId === null) {
      return
    }
    const clientMessageId = orcaShutdownRowClientMessageId(
      input.sessionId,
      input.fence,
      input.generation
    )
    const items = input.journal.snapshot().items
    const written = items.some((item) => {
      const identity = parseAgentJournalItemKey(item.itemId)
      return identity?.provider === 'orca' && identity.clientMessageId === clientMessageId
    })
    if (written || !cutByNobody(items.find((item) => item.itemId === turnItemId))) {
      return
    }
    await input.journal.appendItem(
      { provider: 'orca', clientMessageId },
      orcaStopRowBody(input.trigger),
      { fence: input.fence, turnScope: { kind: 'turn', turnItemId } }
    )
  } catch (error) {
    input.logger.warn('recording why a quit cut a reply failed', {
      scope: 'shutdown-cut-row',
      sessionId: input.sessionId,
      error
    })
  }
}
