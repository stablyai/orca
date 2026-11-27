// Consume /compact output; select its one result: an ordinary provider failure or the command's own row.

import { agentSessionCompactCommandText } from '../../../shared/agent-session/conversation-context/agent-session-conversation-command'
import type {
  AgentSessionContextUsage,
  AgentSessionContextUsed
} from '../../../shared/agent-session/conversation-context/agent-session-context-usage'
import { providerDiagnostic } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { AGENT_SESSION_COMPACTION_SKIPPED_PRESENTATION } from '../../../shared/agent-session/conversation-context/agent-session-compaction'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import { structuredCompactionOutcome } from '../../native-chat/agent-session-wire/operations/structured-conversation-command-outcome'
import type { AcpDialect, AcpTurnEnding } from '../acp-dialects/acp-dialect'
import {
  acpProviderFailed,
  acpStopReasonFailed,
  mergeAcpTurnFailureEvidence,
  type AcpTurnFailureEvidence
} from './acp-turn-failure-evidence'
import type { AcpTurnFailures } from '../timeline/acp-turn-failures'
import { acpUsedEstimate } from '../timeline/acp-context-usage'
import type { ContentBlock, SessionUpdate } from '../generated/acp-protocol.generated'

export function acpCompactPrompt(instructions?: string, command?: string): ContentBlock[] {
  return [{ type: 'text', text: agentSessionCompactCommandText(instructions, command) }]
}

export type AcpCompaction = {
  reply: string
  failure?: AcpTurnFailureEvidence
  startedId?: string
  cancelledId?: string
  /** The agent restated context usage during the compaction. */
  usageReported?: true
}

export type AcpCompactionFrame = {
  failureDetail?: string
  failure?: Pick<AcpTurnEnding, 'stopReason' | 'failureDetail' | 'usageLimit'>
  end?: Omit<AcpTurnEnding, 'at' | 'notSignedIn'>
  usage?: AgentSessionContextUsage
}

/** Returns true when the update belongs to the compaction. */
export function readAcpCompactionUpdate(
  compaction: AcpCompaction,
  update: SessionUpdate,
  dialect: Pick<AcpDialect, 'compactionUpdate'>
): boolean {
  const report =
    update.sessionUpdate === 'compaction_update' ? update : dialect.compactionUpdate?.(update)
  if (report) {
    if (report.status === 'in_progress') {
      compaction.startedId = report.compactionId
    }
    if (report.status === 'cancelled') {
      compaction.cancelledId = report.compactionId
    }
    // Agents report a failed compaction here and still end the prompt normally.
    if (report.status === 'failed') {
      compaction.failure = mergeAcpTurnFailureEvidence(compaction.failure, {
        stopReason: 'error',
        failureDetail: report.error ?? undefined
      })
    }
    return true
  }
  if (update.sessionUpdate === 'agent_message_chunk') {
    if (update.content.type === 'text') {
      compaction.reply += update.content.text
    }
    return true
  }
  return update.sessionUpdate === 'agent_thought_chunk'
}

/** Absorbs compaction output; true suppresses rendering the frame. */
export function absorbAcpCompactionFrame(
  prompt: { compaction?: AcpCompaction; durationMs?: number },
  extension: AcpCompactionFrame | undefined,
  update: SessionUpdate | undefined,
  dialect: Pick<AcpDialect, 'compactionUpdate'>
): boolean {
  const { compaction } = prompt
  if (!compaction) {
    return false
  }
  if (extension?.usage?.used || update?.sessionUpdate === 'usage_update') {
    compaction.usageReported = true
  }
  const failure = extension?.failure ?? extension?.end
  const detail = extension?.failureDetail ?? failure?.failureDetail
  if (detail || (failure && acpStopReasonFailed(failure.stopReason))) {
    compaction.failure = mergeAcpTurnFailureEvidence(compaction.failure, {
      stopReason: failure?.stopReason ?? 'error',
      failureDetail: detail,
      usageLimit: failure?.usageLimit
    })
  }
  const end = extension?.end
  if (end) {
    prompt.durationMs = end.durationMs
    return true
  }
  if (extension?.failure || extension?.failureDetail) {
    return true
  }
  return update !== undefined && readAcpCompactionUpdate(compaction, update, dialect)
}

export function acpCompactionEnd(
  input: AcpTurnEnding & {
    compaction: AcpCompaction
    turn: string
    thread: string
    dialect: AcpDialect
    agentName?: string
    failures: Pick<AcpTurnFailures, 'write'>
  }
): ProviderTimelineEvent[] {
  const { compaction, turn, stopReason } = input
  // The host's command turn has no provider key.
  const join = { thread: input.thread }
  const end = (outcome: 'success' | 'failure' | 'cancellation'): ProviderTimelineEvent => ({
    type: 'turn.end',
    at: input.at,
    state: outcome === 'cancellation' ? 'interrupted' : 'completed',
    outcome,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs })
  })
  const reply =
    stopReason === 'end_turn' ? input.dialect.compactionReply?.(compaction.reply) : undefined
  if (reply?.outcome === 'skipped') {
    const text = providerDiagnostic(reply.detail, 'person')?.text ?? 'Nothing to compact'
    return [
      {
        type: 'item.close',
        item: `compaction:${turn}`,
        body: {
          kind: 'status',
          tone: 'warning',
          text,
          presentation: AGENT_SESSION_COMPACTION_SKIPPED_PRESENTATION
        },
        join
      },
      end('success')
    ]
  }
  // Established provider evidence selects the ordinary failure row instead of the command's own.
  if (acpStopReasonFailed(stopReason)) {
    compaction.failure = mergeAcpTurnFailureEvidence(compaction.failure, input)
    if (acpProviderFailed(compaction.failure)) {
      return [...input.failures.write(turn, compaction.failure, join, stopReason), end('failure')]
    }
  }
  // Settlement already merged its detail behind the first diagnostic the agent reported.
  const words = reply?.detail ?? (compaction.failure?.text || input.failureDetail)
  const detail = words === undefined ? undefined : providerDiagnostic(words, 'person')
  // A cancellation report for an earlier compaction, such as a stale recovery, does not end this one.
  const cancelled =
    compaction.cancelledId !== undefined && compaction.cancelledId === compaction.startedId
  const verdict = structuredCompactionOutcome({
    // Normal completion implies compaction unless the reply or a report says otherwise.
    compacted:
      stopReason === 'end_turn' && reply === undefined && !compaction.failure && !cancelled,
    interruptRequested: stopReason === 'cancelled' || cancelled,
    failed: detail ? { detail } : {}
  })
  if (verdict.outcome === 'cancellation') {
    return [end('cancellation')]
  }
  const failure = verdict.failure
  const body =
    verdict.outcome === 'success' || !failure
      ? { kind: 'status' as const, text: 'Context compacted', presentation: 'compaction' as const }
      : {
          kind: 'status' as const,
          ...agentSessionFailureWords(failure, {
            surface: 'row',
            ...(input.agentName === undefined ? {} : { agentName: input.agentName })
          }),
          tone: 'error' as const
        }
  // The pre-compaction count is stale; it stays unknown until the agent restates it.
  const used =
    verdict.outcome === 'success' && !compaction.usageReported
      ? compactedUsage(input.dialect, compaction.reply, input.at)
      : undefined
  return [
    { type: 'item.close', item: `compaction:${turn}`, body, join },
    ...(used ? [{ type: 'context.usage' as const, usage: { used }, join }] : []),
    end(verdict.outcome)
  ]
}

function compactedUsage(dialect: AcpDialect, reply: string, at: number): AgentSessionContextUsed {
  const tokens = dialect.compactedContextTokens?.(reply)
  return tokens === undefined ? { kind: 'unknown', capturedAt: at } : acpUsedEstimate(tokens, at)
}
