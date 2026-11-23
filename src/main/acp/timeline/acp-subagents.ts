// Track evidence for this provider child; the host owns durable subagent records.

import { createHash, randomUUID } from 'node:crypto'
import type { AgentChildWorkOutcome } from '../../../shared/agent-status/child-work/agent-status-child-work'
import type {
  AgentChildWorkEvidence,
  AgentChildWorkEvidenceHandle
} from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { AGENT_CHILD_WORK_ID_MAX_LENGTH } from '../../../shared/agent-status/child-work/agent-status-child-work-value-guards'
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
  /** ACP names no run, and the host keys a run's saved reply by its handle, so each started run gets its own. */
  run?: string
  replyDigest?: string
  /** Preserve the first terminal state; only completed runs can publish replies. */
  ended?: NativeChatSubagentState
  settlesWithTurn?: boolean
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
  private readonly aliases = new Map<string, string>()
  private readonly pending: AgentChildWorkEvidence[] = []

  /** Include settled subagents so they cannot be reclassified as background tasks. */
  has(id: string): boolean {
    return this.known.has(this.aliases.get(id) ?? id)
  }

  dispose(): void {
    this.known.clear()
    this.aliases.clear()
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
      const id = this.aliases.get(update.id) ?? update.id
      const known = this.known.get(id)
      if (!known && update.knownOnly === true) {
        continue
      }
      for (const alias of update.aliases ?? []) {
        if (alias && alias !== id) {
          this.aliases.set(alias, id)
        }
      }
      const turn = update.turn ?? join.turn
      const subagent = known ?? {
        placement: {
          ...(join.thread === undefined ? {} : { thread: join.thread }),
          ...(turn === undefined ? {} : { turn })
        }
      }
      this.known.set(id, subagent)
      // Only a provider start proves a new run; a late report after reattaching must not reopen one.
      if (update.restart && (subagent.run === undefined || subagent.ended !== undefined)) {
        subagent.run = `acp-child-run:${randomUUID()}`
        subagent.ended = undefined
        subagent.replyDigest = undefined
        if (turn !== undefined) {
          subagent.placement = { ...subagent.placement, turn }
        }
      }
      if (update.settlesWithTurn) {
        subagent.settlesWithTurn = true
      }
      const ending = update.state !== undefined && acpSubagentOutcome(update.state) !== undefined
      // Late live reports must not resurrect an ended run after the host retires its record.
      if (ending || subagent.ended === undefined) {
        this.pending.push(
          subagentEvidence(id === update.id ? update : { ...update, id }, subagent.run, at)
        )
      }
      if (ending) {
        subagent.ended ??= update.state
      }
      if (update.result && subagent.ended === 'completed') {
        replies.push(...this.reply(id, subagent, update.result))
      }
    }
    return replies
  }

  endTurn(turn: string, stopReason: string, at: number): void {
    const terminal: Exclude<NativeChatSubagentState, 'working' | 'idle'> =
      stopReason === 'end_turn' ? 'completed' : stopReason === 'cancelled' ? 'stopped' : 'failed'
    for (const [id, subagent] of this.known) {
      if (
        subagent.settlesWithTurn &&
        subagent.ended === undefined &&
        subagent.placement.turn === turn
      ) {
        subagent.ended = terminal
        this.pending.push(subagentEvidence({ id, state: terminal }, subagent.run, at))
      }
    }
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

// Subagents outlive their spawning prompt.
function subagentEvidence(
  update: AcpSubagentUpdate,
  run: string | undefined,
  observedAt: number
): AgentChildWorkEvidence {
  const handle = subagentHandle(update.id, run)
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

function subagentHandle(id: string, run?: string): AgentChildWorkEvidenceHandle {
  const bounded =
    id.length <= MAX_SUBAGENT_FIELD_CHARS
      ? id
      : `acp-child:${createHash('sha256').update(id).digest('hex')}`
  return {
    idKind: 'task_id',
    id: bounded,
    // Hash the smaller invocation fence while retaining the full handle.
    ...(run !== undefined
      ? { runId: run }
      : bounded.length > AGENT_CHILD_WORK_ID_MAX_LENGTH
        ? { runId: `acp-child:${createHash('sha256').update(bounded).digest('hex')}` }
        : {})
  }
}
