// An ACP agent's subagents, read as evidence for the host's child records, plus each completed
// subagent's reply as its own row.
//
// The host decides what every subagent is doing and writes its saved row; this only reads the
// dialect's updates. It lives as long as the provider child: a subagent an earlier run spawned is
// not known here.

import { createHash } from 'node:crypto'
import { BoundedMap } from '../../shared/bounded-map'
import type { AgentChildWorkOutcome } from '../../shared/agent-status-child-work'
import type {
  AgentChildWorkEvidence,
  AgentChildWorkEvidenceHandle
} from '../../shared/agent-status-child-work-evidence'
import { AGENT_CHILD_WORK_ID_MAX_LENGTH } from '../../shared/agent-status-child-work-value-guards'
import { MAX_SUBAGENT_FIELD_CHARS } from '../../shared/native-chat-subagent-summary'
import type { NativeChatSubagentState } from '../../shared/native-chat-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import { boundSubagentLabel } from '../native-chat/agent-session-journal/journal-subagent-item'
import type { ProviderTimelineJoin } from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpSubagentUpdate } from './acp-dialects/acp-dialect'
import type { AcpTimelineEvent } from './acp-timeline-event'

/** Subagents remembered, so a later report about one is still known as a subagent's. */
const MAX_KNOWN_SUBAGENTS = 2048

type KnownSubagent = {
  /** Where its reply row goes: the turn that spawned it. */
  placement: ProviderTimelineJoin
  /** The reply already written, so a repeated result writes nothing. */
  reply?: string
  /** How it first ended: a reply belongs only to a run that completed. */
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

/** How a subagent's run ended, by the state the dialect read; undefined while it runs. */
export function acpSubagentOutcome(
  state: NativeChatSubagentState
): AgentChildWorkOutcome | undefined {
  return state === 'working' || state === 'idle' ? undefined : OUTCOMES[state]
}

export class AcpSubagents {
  private readonly known = new BoundedMap<string, KnownSubagent>({
    maxEntries: MAX_KNOWN_SUBAGENTS
  })
  private readonly pending: AgentChildWorkEvidence[] = []

  /** Known children include settled ones, so they cannot become background tasks. */
  has(id: string): boolean {
    return this.known.has(id)
  }

  dispose(): void {
    this.known.clear()
    this.pending.length = 0
  }

  /** What the updates translated since the last drain said, for the host's records. */
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
      // A late report about an ended run is not a new run: the host drops the run's record at the
      // next send, so a live edge then would bring it back as working.
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
    const bounded = boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
    if (subagent.reply === bounded) {
      return []
    }
    subagent.reply = bounded
    return [
      {
        type: 'item.update',
        item: `subagent-result:${id}`,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: bounded }] },
        producer: { agentId: id, producerKind: 'agent' },
        join: subagent.placement
      }
    ]
  }
}

/** A subagent runs on past the prompt turn that spawned it, and the provider names no run. */
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
        // The strip and the saved row show the same label.
        ...(update.label !== undefined ? { description: boundSubagentLabel(update.label) } : {}),
        ...(update.tokens !== undefined ? { totalTokens: update.tokens } : {}),
        // An id the handle had to digest cannot address the provider's cancellation.
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
    // Invocation fences are smaller than handles; keep the full stable handle.
    ...(bounded.length > AGENT_CHILD_WORK_ID_MAX_LENGTH
      ? { runId: `acp-child:${createHash('sha256').update(bounded).digest('hex')}` }
      : {})
  }
}
