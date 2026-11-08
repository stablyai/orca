import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  agentJournalTurnRowReservedBytes,
  type AgentJournalTurnRowWrite
} from '../native-chat/agent-session-timeline/agent-journal-turn-row-revision'

function claudeTerminalFailureIdentity(turnItemId: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `terminal-failure:claude:${turnItemId}` }
}

const CLAUDE_VOICE = { agentName: 'Claude', provider: 'claude' } as const

export function writeClaudeTerminalFailure(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody
): void {
  const turnItemId = agentJournalItemKey(identity)
  const failureIdentity = claudeTerminalFailureIdentity(turnItemId)
  const options = { turnScope: { kind: 'turn' as const, turnItemId }, lifecycle: true }
  const revise = sink.tryReviseResolvedItemAndPublish
  if (!revise) {
    sink.appendItem(failureIdentity, body, options)
    sink.publish()
    return
  }
  const reservedBytes = Buffer.byteLength(JSON.stringify({ failureIdentity, body }), 'utf8') + 8192
  revise.call(
    sink,
    reservedBytes,
    { kind: 'turn-failure', identity: failureIdentity, body, voice: CLAUDE_VOICE },
    options
  )
}

// Refine only the ending row after its quota and any person Stop have landed.
export function refineClaudeQuotaTurnEnd(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  write: AgentJournalTurnRowWrite
): boolean {
  const revise = sink.tryReviseResolvedItemAndPublish
  if (!revise || !write.lifecycle || write.lifecycle.outcome !== undefined) {
    return false
  }
  revise.call(
    sink,
    agentJournalTurnRowReservedBytes({ identity }, write),
    {
      kind: 'quota-turn-end',
      identity,
      failureItemId: agentJournalItemKey(
        claudeTerminalFailureIdentity(agentJournalItemKey(identity))
      ),
      write
    },
    { turnScope: { kind: 'thread' }, lifecycle: true }
  )
  return true
}
