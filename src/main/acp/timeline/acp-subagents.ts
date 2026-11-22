// Track evidence for this provider child; the host owns durable subagent records.

import { createHash, randomUUID } from 'node:crypto'
import type { AgentChildWorkOutcome } from '../../../shared/agent-status/child-work/agent-status-child-work'
import type {
  AgentChildWorkEvidence,
  AgentChildWorkEvidenceHandle
} from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { MAX_SUBAGENT_FIELD_CHARS } from '../../../shared/native-chat/transcript/subagents/native-chat-subagent-summary'
import type { NativeChatSubagentState } from '../../../shared/native-chat/native-chat-types'
import { boundSubagentLabel } from '../../native-chat/agent-session-journal/item-lifecycle/journal-subagent-item'
import type {
  ProviderTimelineJoin,
  ProviderTimelineEvent
} from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpSubagentUpdate } from '../acp-dialects/acp-dialect'

type KnownSubagent = {
  /** Pin replies to the spawning turn. */
  placement: ProviderTimelineJoin
  /** ACP names no run, and the host keys a run's saved reply by its handle, so each run gets its own. */
  run: string
  replyDigest?: string
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

  reconcile(
    id: string,
    state: NativeChatSubagentState,
    thread: string,
    at: number
  ): ProviderTimelineEvent[] {
    return this.translate([{ id, state, knownOnly: true }], { thread }, at)
  }

  translate(
    updates: readonly AcpSubagentUpdate[],
    join: ProviderTimelineJoin,
    at: number
  ): ProviderTimelineEvent[] {
    const replies: ProviderTimelineEvent[] = []
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
        },
        run: newRun()
      }
      this.known.set(update.id, subagent)
      if (update.restart && subagent.ended !== undefined) {
        subagent.run = newRun()
        subagent.ended = undefined
        subagent.replyDigest = undefined
      }
      const ending = update.state !== undefined && acpSubagentOutcome(update.state) !== undefined
      // Late live reports must not resurrect an ended run after the host retires its record.
      if (ending || subagent.ended === undefined) {
        this.pending.push(subagentEvidence(update, subagent.run, at))
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

  private reply(id: string, subagent: KnownSubagent, text: string): ProviderTimelineEvent[] {
    const digest = createHash('sha256').update(text, 'utf16le').digest('hex')
    if (subagent.replyDigest === digest) {
      return []
    }
    subagent.replyDigest = digest
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

function newRun(): string {
  return `acp-child-run:${randomUUID()}`
}

// Subagents outlive their spawning prompt.
function subagentEvidence(
  update: AcpSubagentUpdate,
  runId: string,
  observedAt: number
): AgentChildWorkEvidence {
  const id = subagentId(update.id)
  const handle: AgentChildWorkEvidenceHandle = { idKind: 'task_id', id, runId }
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
        ...(update.ownerId !== undefined ? { ownerId: subagentId(update.ownerId) } : {}),
        // Hashed handles cannot address provider cancellation.
        stoppable: id === update.id
      },
      ...(update.restart ? { restart: true } : {})
    }
  }
  const lastMessage = update.error || update.reply
  return {
    type: 'ended',
    observedAt,
    handle,
    outcome,
    ...(lastMessage ? { lastMessage } : {}),
    ...(update.tokens !== undefined ? { totalTokens: update.tokens } : {})
  }
}

function subagentId(id: string): string {
  return id.length <= MAX_SUBAGENT_FIELD_CHARS
    ? id
    : `acp-child:${createHash('sha256').update(id).digest('hex')}`
}
