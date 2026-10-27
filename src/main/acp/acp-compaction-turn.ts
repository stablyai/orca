// Consume /compact output without rendering it; end the command turn with one result row.

import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { AGENT_SESSION_COMPACTION_SKIPPED_PRESENTATION } from '../../shared/agent-session-compaction'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { structuredCompactionOutcome } from '../native-chat/agent-session-wire/structured-conversation-command-outcome'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import type { ContentBlock, SessionUpdate } from './generated/acp-protocol.generated'

export const ACP_COMPACT_PROMPT: readonly ContentBlock[] = [{ type: 'text', text: '/compact' }]

export type AcpCompaction = { reply: string; failureDetail?: string }

export type AcpCompactionFrame = {
  failureDetail?: string
  end?: { durationMs?: number; failureDetail?: string }
}

/** Returns true when the update belongs to the compaction. */
export function readAcpCompactionUpdate(compaction: AcpCompaction, update: SessionUpdate): boolean {
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
  update: SessionUpdate | undefined
): boolean {
  const { compaction } = prompt
  if (!compaction) {
    return false
  }
  if (extension?.failureDetail) {
    compaction.failureDetail = extension.failureDetail
  }
  const end = extension?.end
  if (end) {
    prompt.durationMs = end.durationMs
    if (end.failureDetail) {
      compaction.failureDetail = end.failureDetail
    }
    return true
  }
  return update !== undefined && readAcpCompactionUpdate(compaction, update)
}

export function acpCompactionEnd(input: {
  compaction: AcpCompaction
  turn: string
  thread: string
  stopReason: string
  at: number
  durationMs?: number
  failureDetail?: string
  notSignedIn?: boolean
  dialect: AcpDialect
  agentName?: string
}): ProviderTimelineEvent[] {
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
  const words = reply?.detail ?? input.failureDetail ?? compaction.failureDetail
  const detail = words === undefined ? undefined : providerDiagnostic(words, 'person')
  const verdict = structuredCompactionOutcome({
    // Normal completion implies compaction unless the reply says otherwise.
    compacted: stopReason === 'end_turn' && reply === undefined,
    interruptRequested: stopReason === 'cancelled',
    failed: detail ? { detail } : {}
  })
  if (verdict.outcome === 'cancellation') {
    return [end('cancellation')]
  }
  // Use signed-out guidance and replace the child, as for a signed-out send.
  const failure =
    verdict.failure && input.notSignedIn
      ? agentSessionFailureFact('notSignedIn', detail ? { detail } : {})
      : verdict.failure
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
  return [{ type: 'item.close', item: `compaction:${turn}`, body, join }, end(verdict.outcome)]
}
