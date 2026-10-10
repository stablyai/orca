import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import type { AgentChildWorkOutcome } from '../../shared/agent-status-child-work'
import { isSubagentGroupBlock } from '../../shared/native-chat-types'
import type { AcpTimelineEvent } from './acp-timeline-event'
import { createHash } from 'node:crypto'
import { AGENT_CHILD_WORK_ID_MAX_LENGTH } from '../../shared/agent-status-child-work-value-guards'

export function isAcpSubagentChildWorkEvent(event: AcpTimelineEvent): boolean {
  return (
    event.type === 'session.ended' ||
    (['item.open', 'item.update', 'item.close'].includes(event.type) &&
      'body' in event &&
      event.body.kind === 'message' &&
      event.body.blocks.some(isSubagentGroupBlock))
  )
}

/** Project the admitted snapshot, never the translator's potentially newer roster. */
export function acpSubagentChildWork(
  event: AcpTimelineEvent,
  observedAt: number,
  stoppable: boolean
): AgentChildWorkEvidence[] {
  if (event.type === 'session.ended') {
    return [{ type: 'session-ended', observedAt }]
  }
  if (
    !['item.open', 'item.update', 'item.close'].includes(event.type) ||
    !('body' in event) ||
    event.body.kind !== 'message'
  ) {
    return []
  }
  const evidence: AgentChildWorkEvidence[] = []
  for (const block of event.body.blocks) {
    if (!isSubagentGroupBlock(block)) {
      continue
    }
    for (const [index, child] of block.agents.entries()) {
      const identity = event.subagentIdentities?.[index] ?? child.id
      const handle = {
        idKind: 'task_id' as const,
        id: identity,
        // Invocation fences are smaller than aliases; keep the roster's full stable handle.
        ...(identity.length > AGENT_CHILD_WORK_ID_MAX_LENGTH
          ? { runId: `acp-child:${createHash('sha256').update(identity).digest('hex')}` }
          : {})
      }
      if (child.state === 'working') {
        evidence.push({
          type: 'live',
          observedAt,
          child: {
            handle,
            kind: 'agent',
            residency: 'background',
            state: 'working',
            description: child.label,
            totalTokens: child.tokens,
            // Display-clipped handles cannot safely address the provider's cancellation API.
            stoppable: stoppable && identity === child.id && !/…~\d+$/.test(child.id)
          }
        })
      } else {
        const outcome: AgentChildWorkOutcome =
          child.state === 'failed'
            ? 'failed'
            : child.state === 'stopped'
              ? 'cancelled'
              : child.state === 'unverifiable'
                ? 'unknown'
                : 'succeeded'
        evidence.push({ type: 'ended', observedAt, handle, outcome, totalTokens: child.tokens })
      }
    }
  }
  return evidence
}
