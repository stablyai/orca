import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  AGENT_SESSION_ORCA_STOP_PRESENTATION,
  isAgentSessionOrcaStopCause
} from '../../../shared/agent-session-orca-stop'
import type { AgentSessionResumeTrigger } from '../../../shared/agent-session-resume-marker'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
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
import { orcaShutdownRowClientMessageId } from '../../../shared/native-chat/native-chat-orca-stop-cut'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

type OrcaStopRowJournal = Pick<AgentSessionJournal, 'snapshot' | 'appendItem'>

/** Keep legacy stop wording/tone alongside the cause that newer clients render muted. */
export function orcaStopRowBody(
  context: AgentSessionFailureWordsContext | undefined,
  orcaEnd: unknown
): AgentJournalStatusItem {
  return {
    kind: 'status',
    ...agentSessionFailureWords(agentSessionFailureFact('providerExited'), {
      ...context,
      surface: 'row'
    }),
    tone: 'error',
    ...(isAgentSessionOrcaStopCause(orcaEnd)
      ? { presentation: AGENT_SESSION_ORCA_STOP_PRESENTATION, orcaStop: { cause: orcaEnd } }
      : {})
  }
}

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

/** Explain quit-cut turns after settlement, excluding completed/personal stops; never block quit on failure. */
export async function recordStructuredAgentSessionShutdownCut(input: {
  journal: OrcaStopRowJournal
  sessionId: string
  /** Stopped-child fence keys row identity. */
  fence: number
  /** Current lease fence, advanced beyond the stopped child. */
  rowFence: number
  generation: string
  turnItemId: string | null
  trigger: AgentSessionResumeTrigger
  failureTextContext?: AgentSessionFailureWordsContext
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
      orcaStopRowBody(input.failureTextContext, input.trigger),
      { fence: input.rowFence, turnScope: { kind: 'turn', turnItemId } }
    )
  } catch (error) {
    input.logger.warn('recording why a quit cut a reply failed', {
      scope: 'shutdown-cut-row',
      sessionId: input.sessionId,
      error
    })
  }
}
