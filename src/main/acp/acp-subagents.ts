// Track evidence for this provider child; the host owns durable subagent records.

import { createHash } from 'node:crypto'
import type { AgentChildWorkOutcome } from '../../shared/agent-status-child-work'
import type {
  AgentChildWorkEvidence,
  AgentChildWorkEvidenceHandle
} from '../../shared/agent-status-child-work-evidence'
import { AGENT_CHILD_WORK_ID_MAX_LENGTH } from '../../shared/agent-status-child-work-value-guards'
import { MAX_SUBAGENT_FIELD_CHARS } from '../../shared/native-chat/transcript/native-chat-subagent-summary'
import type { NativeChatSubagentState } from '../../shared/native-chat-types'
import { boundSubagentLabel } from '../native-chat/agent-session-journal/journal-subagent-item'
import type { ProviderTimelineJoin } from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpSubagentUpdate } from './acp-dialects/acp-dialect'
import type { AcpTimelineEvent } from './acp-timeline-event'

type KnownSubagent = {
  /** Pin replies to the spawning turn. */
  placement: ProviderTimelineJoin
  reply?: string
  /** Preserve the first terminal state; only completed runs can publish replies. */
  ended?: NativeChatSubagentState
}

const OUTCOMES: Record<
  Exclude<NativeChatSubagentState, 'working' | 'idle'>,
  AgentChildWorkOutcome
> = {
  completed: 'succeeded',
  failed: 'failed',
  stopped: 'cancelled',
  unverifiable: 'unknown'
}

export function acpSubagentOutcome(
  state: NativeChatSubagentState
): AgentChildWorkOutcome | undefined {
  return state === 'working' || state === 'idle' ? undefined : OUTCOMES[state]
}

export class AcpSubagents {
  private readonly known = new Map<string, KnownSubagent>()
  private readonly pending: AgentChildWorkEvidence[] = []

  /** Include settled subagents so they cannot be reclassified as background tasks. */
  has(id: string): boolean {
    return this.known.has(id)
  }

  dispose(): void {
    this.known.clear()
    this.pending.length = 0
  }

  drainEvidence(): AgentChildWorkEvidence[] {
    return this.pending.splice(0)
  }

  translate(
    updates: readonly AcpSubagentUpdate[],
    join: ProviderTimelineJoin,
    at: number
  ): AcpTimelineEvent[] {
    const replies: AcpTimelineEvent[] = []
    for (const update of updates) {
      const known = this.known.get(update.id)
      if (!known && update.knownOnly === true) {
        continue
      }
      const turn = update.turn ?? join.turn
      const subagent = known ?? {
        placement: {
          ...(join.thread === undefined ? {} : { thread: join.thread }),
          ...(turn === undefined ? {} : { turn })
        }
      }
      this.known.set(update.id, subagent)
      const ending = update.state !== undefined && acpSubagentOutcome(update.state) !== undefined
      // Late live reports must not resurrect an ended run after the host retires its record.
      if (ending || subagent.ended === undefined) {
        this.pending.push(subagentEvidence(update, at))
      }
      if (ending) {
        subagent.ended ??= update.state
      }
      if (update.result && subagent.ended === 'completed') {
        replies.push(...this.reply(update.id, subagent, update.result))
      }
    }
    return replies
  }

  private reply(id: string, subagent: KnownSubagent, text: string): AcpTimelineEvent[] {
    if (subagent.reply === text) {
      return []
    }
    subagent.reply = text
    return [
      {
        type: 'item.update',
        item: `subagent-result:${id}`,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
        producer: { agentId: id, producerKind: 'agent' },
        join: subagent.placement
      }
    ]
  }
}

// Subagents outlive their spawning prompt and have no provider run identity.
function subagentEvidence(update: AcpSubagentUpdate, observedAt: number): AgentChildWorkEvidence {
  const handle = subagentHandle(update.id)
  const outcome = update.state === undefined ? undefined : acpSubagentOutcome(update.state)
  if (outcome === undefined) {
    return {
      type: 'live',
      observedAt,
      child: {
        handle,
        kind: 'agent',
        residency: 'background',
        state: update.state === 'idle' ? 'idle' : 'working',
        ...(update.label !== undefined ? { description: boundSubagentLabel(update.label) } : {}),
        ...(update.tokens !== undefined ? { totalTokens: update.tokens } : {}),
        // Hashed handles cannot address provider cancellation.
        stoppable: handle.id === update.id
      }
    }
  }
  return {
    type: 'ended',
    observedAt,
    handle,
    outcome,
    ...(update.tokens !== undefined ? { totalTokens: update.tokens } : {})
  }
}

function subagentHandle(id: string): AgentChildWorkEvidenceHandle {
  const bounded =
    id.length <= MAX_SUBAGENT_FIELD_CHARS
      ? id
      : `acp-child:${createHash('sha256').update(id).digest('hex')}`
  return {
    idKind: 'task_id',
    id: bounded,
    // Hash the smaller invocation fence while retaining the full handle.
    ...(bounded.length > AGENT_CHILD_WORK_ID_MAX_LENGTH
      ? { runId: `acp-child:${createHash('sha256').update(bounded).digest('hex')}` }
      : {})
  }
}
