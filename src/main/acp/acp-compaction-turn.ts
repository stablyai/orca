// Consume /compact output; select its one result: an ordinary provider failure or the command's own row.

import { agentSessionCompactCommandText } from '../../shared/agent-session/agent-session-conversation-command'
import { providerDiagnostic } from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import { AGENT_SESSION_COMPACTION_SKIPPED_PRESENTATION } from '../../shared/agent-session/agent-session-compaction'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { structuredCompactionOutcome } from '../native-chat/agent-session-wire/structured-conversation-command-outcome'
import type { AcpDialect, AcpTurnEnding } from './acp-dialects/acp-dialect'
import {
  acpProviderFailed,
  acpStopReasonFailed,
  mergeAcpTurnFailureEvidence,
  type AcpTurnFailureEvidence,
  type AcpTurnFailures
} from './acp-turn-failures'
import type { ContentBlock, SessionUpdate } from './generated/acp-protocol.generated'

export function acpCompactPrompt(instructions?: string): ContentBlock[] {
  return [{ type: 'text', text: agentSessionCompactCommandText(instructions) }]
}

export type AcpCompaction = { reply: string; failure?: AcpTurnFailureEvidence }

export type AcpCompactionFrame = {
  failureDetail?: string
  failure?: Pick<AcpTurnEnding, 'stopReason' | 'failureDetail' | 'usageLimit'>
  end?: Omit<AcpTurnEnding, 'at' | 'notSignedIn'>
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
  return update !== undefined && readAcpCompactionUpdate(compaction, update)
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
  const verdict = structuredCompactionOutcome({
    // Normal completion implies compaction unless the reply says otherwise.
    compacted: stopReason === 'end_turn' && reply === undefined,
    interruptRequested: stopReason === 'cancelled',
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
  return [{ type: 'item.close', item: `compaction:${turn}`, body, join }, end(verdict.outcome)]
}
