import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionExecutionLocationsEqual } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  buildCrossVendorHandoffPrompt,
  crossVendorHistoryRowId,
  crossVendorHistoryRows,
  crossVendorNoteId,
  MAX_CROSS_VENDOR_HISTORY_ROWS
} from '../../../../shared/agent-session/conversation-context/cross-vendor-handoff'
import { tuiAgentDisplayName } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { StructuredAgentSessionHost } from '../host/structured-agent-session-host'
import { structuredAgentSessionConversationFence } from '../host/structured-agent-session-provider-child'
import type { CrossVendorHandoffSeeds } from './cross-vendor-handoff-seeds'

export type CrossVendorHandoffResult = { copied: number; seeded: boolean }

/** Copies the source chat's words into a fresh chat of another agent and owes that agent them as
 *  context on its first turn. Safe to repeat: the same rows are revised, never duplicated. */
export async function runCrossVendorHandoff(
  host: Pick<StructuredAgentSessionHost, 'deps' | 'conversation' | 'reads'>,
  seeds: CrossVendorHandoffSeeds,
  params: { sessionId: string; sourceSessionId: string }
): Promise<CrossVendorHandoffResult> {
  const { store } = host.deps
  const target = store.getRecord(params.sessionId)
  const source = store.getRecord(params.sourceSessionId)
  if (
    !target ||
    !source ||
    params.sessionId === params.sourceSessionId ||
    !agentSessionExecutionLocationsEqual(target.location, source.location)
  ) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
  // A chat whose agent already answered has its own context; seeding it again would repeat it.
  if (target.providerHandleChain.length > 0) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
  const page = await host.reads.agentReadPage(params.sourceSessionId, MAX_CROSS_VENDOR_HISTORY_ROWS)
  const rows = crossVendorHistoryRows(page.entries)
  const sourceAgent = tuiAgentDisplayName(source.provider) ?? source.provider
  const targetAgent = tuiAgentDisplayName(target.provider) ?? target.provider
  const { journal } = await host.conversation(params.sessionId)
  const fence = structuredAgentSessionConversationFence(store, params.sessionId)
  const write = (clientMessageId: string, body: AgentJournalItemBody) =>
    journal.appendItem({ provider: 'orca', clientMessageId }, body, {
      fence,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  for (const [index, row] of rows.entries()) {
    await write(crossVendorHistoryRowId(params.sourceSessionId, index), {
      kind: 'message',
      role: row.role,
      blocks: [{ type: 'text', text: row.text }]
    })
  }
  await write(crossVendorNoteId(params.sourceSessionId), {
    kind: 'status',
    text:
      rows.length > 0
        ? `Switched from ${sourceAgent} to ${targetAgent}. ${targetAgent} continues with the conversation above as context.`
        : `Switched from ${sourceAgent} to ${targetAgent}.`
  })
  const prompt = buildCrossVendorHandoffPrompt({ rows, sourceAgent, targetAgent })
  if (prompt) {
    await seeds.put(params.sessionId, prompt)
  }
  return { copied: rows.length, seeded: prompt !== null }
}
