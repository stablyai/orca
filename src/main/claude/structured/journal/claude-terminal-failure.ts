import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  agentJournalTurnRowReservedBytes,
  type AgentJournalTurnRowWrite
} from '../../../native-chat/agent-session-timeline/agent-journal-turn-row-revision'
import type { JournalTimelineItemResolution } from '../../../native-chat/agent-session-journal/writing/journal-timeline-resolution'
import { writeClaudeStopReadings, type ClaudeStopCheck } from '../../claude-stop-readings'

function claudeTerminalFailureIdentity(turnItemId: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `terminal-failure:claude:${turnItemId}` }
}

const CLAUDE_VOICE = { agentName: 'Claude', provider: 'claude' } as const

export function writeClaudeTerminalFailure(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  stopCheck: ClaudeStopCheck | null = null
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
  const failure = {
    kind: 'turn-failure',
    identity: failureIdentity,
    body,
    voice: CLAUDE_VOICE
  } as const
  // A person's Stop leaves no failure notice.
  if (
    stopCheck &&
    writeClaudeStopReadings(
      sink,
      stopCheck,
      { ran: failure, stopped: null, reservedBytes },
      options,
      { publish: true }
    )
  ) {
    return
  }
  revise.call(sink, reservedBytes, failure, options)
}

/** The writer chooses the quota ending's outcome after its failure row and any Stop. */
export function claudeQuotaTurnEndResolution(
  identity: AgentJournalItemIdentity,
  write: AgentJournalTurnRowWrite
): Extract<JournalTimelineItemResolution, { kind: 'quota-turn-end' }> {
  return {
    kind: 'quota-turn-end',
    identity,
    failureItemId: agentJournalItemKey(
      claudeTerminalFailureIdentity(agentJournalItemKey(identity))
    ),
    write
  }
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
    claudeQuotaTurnEndResolution(identity, write),
    { turnScope: { kind: 'thread' }, lifecycle: true }
  )
  return true
}
