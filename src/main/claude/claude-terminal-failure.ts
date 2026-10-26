import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../shared/agent-session-journal-producer'
import { readAgentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionRevisionJournal
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  agentJournalTurnRowReservedBytes,
  resolveAgentJournalTurnRowWrite,
  type AgentJournalTurnRowWrite
} from '../native-chat/agent-session-timeline/agent-journal-turn-row-revision'

function claudeTerminalFailureIdentity(turnItemId: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `terminal-failure:claude:${turnItemId}` }
}

export function writeClaudeTerminalFailure(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody
): void {
  const turnItemId = agentJournalItemKey(identity)
  const failureIdentity = claudeTerminalFailureIdentity(turnItemId)
  const options = {
    criticalRoot: true as const,
    turnScope: { kind: 'turn' as const, turnItemId },
    lifecycle: true
  }
  const revise = sink.tryReviseResolvedItemAndPublish
  if (!revise) {
    sink.appendItem(failureIdentity, body, options)
    sink.publish({ criticalRoot: true })
    return
  }
  const reservedBytes = Buffer.byteLength(JSON.stringify({ failureIdentity, body }), 'utf8') + 8192
  revise.call(
    sink,
    reservedBytes,
    (journal) => mergeClaudeTerminalFailure(journal, identity, body),
    options
  )
}

function mergeClaudeTerminalFailure(
  journal: StructuredAgentSessionRevisionJournal,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody
) {
  const failureIdentity = claudeTerminalFailureIdentity(agentJournalItemKey(identity))
  const old = journal.itemBody(agentJournalItemKey(failureIdentity))
  const prior = old?.kind === 'status' ? readAgentSessionFailureFact(old.failure) : undefined
  const next = body.kind === 'status' ? readAgentSessionFailureFact(body.failure) : undefined
  const previousDetail = prior?.detail?.text
  const incomingDetail = next?.detail?.text
  const detail =
    previousDetail && incomingDetail && !previousDetail.includes(incomingDetail)
      ? `${previousDetail}\n${incomingDetail}`
      : (previousDetail ?? incomingDetail ?? '')
  const merged =
    prior?.kind === 'usageLimitReached' && next?.kind === 'usageLimitReached'
      ? {
          ...body,
          ...agentSessionFailureWords(
            {
              ...prior,
              ...next,
              usageLimit: next.usageLimit ?? prior.usageLimit,
              detail: providerDiagnostic(detail, 'person')
            },
            { agentName: 'Claude', provider: 'claude', surface: 'row' }
          )
        }
      : body
  return JSON.stringify(merged) === JSON.stringify(old)
    ? null
    : { identity: failureIdentity, body: merged }
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
  const lifecycle = write.lifecycle
  const target = { identity }
  const reservedBytes = agentJournalTurnRowReservedBytes(target, write)
  revise.call(
    sink,
    reservedBytes,
    (journal) => {
      const itemId = agentJournalItemKey(identity)
      const row = journal.item(agentJournalItemKey(claudeTerminalFailureIdentity(itemId)))
      const quota =
        row?.body.kind === 'status' &&
        isRootAgentJournalItem(row) &&
        row.turnScope?.kind === 'turn' &&
        row.turnScope.turnItemId === itemId &&
        readAgentSessionFailureFact(row.body.failure)?.kind === 'usageLimitReached'
      const stopped =
        lifecycle.completedAt !== undefined &&
        sink.journalStopDecidesTurn?.(lifecycle.turnId, lifecycle.completedAt)
      const outcome = quota ? (stopped ? 'cancellation' : 'failure') : undefined
      return resolveAgentJournalTurnRowWrite(
        journal,
        target,
        {
          ...write,
          lifecycle: { ...lifecycle, ...(outcome ? { outcome } : {}) }
        },
        reservedBytes
      )
    },
    { criticalRoot: true, lifecycle: true, turnScope: { kind: 'thread' } }
  )
  return true
}
