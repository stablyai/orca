import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalTurnBody } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { structuredAgentSessionCommandTurn } from '../../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import type { JournalCommandOpenInput } from '../journal-store-contracts'
import type { JournalReducerState } from '../projection/journal-reducer'
import { journalDispatchRowBuilder, journalItemRowBuilder } from './journal-row-builders'
import type { JournalRowWriter } from './journal-row-writer'

export type JournalCommandOpenResult = {
  turn: ReturnType<typeof structuredAgentSessionCommandTurn>
  running: AgentJournalTurnItem
}

/** Handover survives a later turn-write failure; timing is read at the turn's write position. */
export async function openJournalCommand(
  deps: { state: () => JournalReducerState; writer: JournalRowWriter },
  input: JournalCommandOpenInput
): Promise<JournalCommandOpenResult> {
  const turn = structuredAgentSessionCommandTurn(input.clientMessageId)
  await deps.writer.append(
    journalDispatchRowBuilder(deps.state, {
      clientMessageId: input.clientMessageId,
      state: 'pending',
      fence: input.fence,
      turnScope: input.turnScope
    })
  )
  let running: AgentJournalTurnItem | undefined
  await deps.writer.append((seq, ts) => {
    running = agentJournalTurnBody({
      turnId: turn.turnId,
      state: 'running',
      userItemId: agentJournalSubmissionKey(input.clientMessageId),
      requestedAt:
        deps.state().submissions.get(input.clientMessageId)?.handedOverAt ?? input.submittedAt,
      startedAt: ts
    })
    return journalItemRowBuilder(deps.state, turn.identity, running, {
      fence: input.fence,
      observedAt: ts,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })(seq, ts)
  })
  return { turn, running: running! }
}
