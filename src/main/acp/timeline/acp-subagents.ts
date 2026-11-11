// Track evidence for this provider child; the host owns durable subagent records.

import { createHash } from 'node:crypto'
import type { AgentChildWorkOutcome } from '../../../shared/agent-status/child-work/agent-status-child-work'
import type {
  AgentChildWorkEvidence,
  AgentChildWorkEvidenceHandle
} from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { AGENT_CHILD_WORK_ID_MAX_LENGTH } from '../../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import { MAX_SUBAGENT_FIELD_CHARS } from '../../../shared/native-chat/transcript/native-chat-subagent-summary'
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
  /** Last accepted `_omp/subagents` snapshot seq; -1 until one arrives. */
  private rosterSeq = -1

  /** Include settled subagents so they cannot be reclassified as background tasks. */
  has(id: string): boolean {
    return this.known.has(id)
  }

  /** Accepted snapshots supersede task-tool progress. */
  hasRoster(): boolean {
    return this.rosterSeq >= 0
  }

  /** Snapshots replace the roster; a repeated or older seq is stale. Retained ids stay live. */
  translateRoster(
    roster: { seq: number; children: readonly AcpSubagentUpdate[]; retainedIds: readonly string[] },
    join: ProviderTimelineJoin,
    at: number
  ): ProviderTimelineEvent[] {
    const { seq, children, retainedIds } = roster
    if (seq <= this.rosterSeq) {
      return []
    }
    this.rosterSeq = seq
    const present = new Set([...children.map((child) => child.id), ...retainedIds])
    const updates: AcpSubagentUpdate[] = children.map((child) =>
      child.state === 'working' && this.known.get(child.id)?.ended !== undefined
        ? { ...child, restart: true as const }
        : child
    )
    for (const id of this.known.keys()) {
      if (!present.has(id)) {
        updates.push({ id, state: 'stopped', knownOnly: true })
      }
    }
    return this.translate(updates, join, at)
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
        }
      }
      this.known.set(update.id, subagent)
      if (update.restart && subagent.ended !== undefined) {
        subagent.ended = undefined
        subagent.replyDigest = undefined
      }
      const ending = update.state !== undefined && acpSubagentOutcome(update.state) !== undefined
      // Late live reports must not resurrect an ended run after the host retires its record.
      if (subagent.ended === undefined) {
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
        ...(update.ownerId !== undefined ? { ownerId: subagentHandle(update.ownerId).id } : {}),
        // Hashed handles cannot address provider cancellation.
        stoppable: handle.id === update.id
      },
      ...(update.restart ? { restart: true } : {})
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
