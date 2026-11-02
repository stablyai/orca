/** A create this caller already recorded answers from that record, before fresh support is asked:
 * a changed CLI or lost Setup observer cannot turn a committed chat into a refusal, nor a refused or
 * unknown create into a new one. */

import type { AgentSessionMutationEnvelope } from '../../../../shared/agent-session/agent-session-wire'
import { agentSessionLedgerRefusal } from '../../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { StructuredAgentSessionFirstMessage } from '../../../../shared/agent-session/structured-agent-session-create'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  agentSessionOperationOutcomeUnknown,
  resolveAgentSessionReplayOutcome
} from '../../../native-chat/agent-session-wire/structured-agent-session-replay-outcome'
import type { PreparedStructuredAgentSessionCreate } from './structured-agent-session-create'
import type { StructuredCreateRefused } from './structured-agent-session-precommit-refusal'

/** Null leaves the create to fresh preparation: no row, or a row only that preparation can match. */
export function replayRecordedAtRestCreate(
  host: StructuredAgentSessionHost,
  args: {
    caller: { callerKey: string }
    envelope: AgentSessionMutationEnvelope
    agent: StructuredAgentId
    atRest: boolean
    tabId?: string
    firstMessage?: StructuredAgentSessionFirstMessage
    options?: Readonly<Record<string, string>>
  }
): PreparedStructuredAgentSessionCreate | StructuredCreateRefused | null {
  const { envelope, agent } = args
  const row = host.deps.store.getOperationRow(args.caller.callerKey, envelope.clientOperationId)
  if (!row) {
    return null
  }
  if (row.fingerprint !== envelope.payloadFingerprint) {
    // A legacy create's row holds an attach fingerprint only preparation recomputes; an at-rest
    // create carrying a message or options never wrote one, so this id was reused.
    const legacyShaped = !args.atRest || (args.firstMessage === undefined && !args.options)
    return legacyShaped
      ? null
      : {
          refusal: agentSessionLedgerRefusal(envelope, {
            decision: 'refused',
            code: 'agent_session_operation_conflict',
            details: { reason: 'operationIdReused' }
          })
        }
  }
  const record = host.deps.store.getRecord(envelope.sessionId)
  const replay = resolveAgentSessionReplayOutcome({
    operationId: envelope.clientOperationId,
    outcome: row.outcome,
    reconstruct: () =>
      row.outcome.status === 'succeeded' &&
      record?.sessionId === row.outcome.sessionId &&
      record.provider === agent
        ? record
        : null
  })
  if (replay.decision !== 'replay') {
    return {
      refusal:
        replay.decision === 'refuse'
          ? replay.refusal
          : agentSessionOperationOutcomeUnknown(envelope.clientOperationId)
    }
  }
  const { location, accountHome } = replay.value
  // The host's own ledger replays this create; nothing here starts or reseeds the chat.
  return {
    host,
    attachParams: {
      envelope,
      location,
      provider: agent,
      agent,
      accountHome,
      runtimeKind: 'native',
      ...(args.tabId ? { surfaceTabId: args.tabId } : {})
    },
    atRest: args.firstMessage ? { firstMessage: args.firstMessage } : {},
    tab: { workspaceId: location.workspaceId, agent }
  }
}
