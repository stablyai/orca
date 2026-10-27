import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  endedJournalReasoning,
  journalReasoningBody
} from '../native-chat/agent-session-journal/journal-reasoning-row'
import type { AgentSessionDeltaCoalescerDeps } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeStreamedBlockRegistry } from './claude-streamed-block-identity'
import {
  createClaudeStreamedTextCheckpoints,
  type ClaudeStreamedBlockEnd
} from './claude-streamed-text-checkpoints'
import {
  claudeRecord,
  claudeText,
  claudeThinkingIdentity,
  claudeThinkingText,
  type ClaudeMessageEnvelope
} from './claude-structured-item-translation'
import type { ClaudeSubagentLinkageSource } from './claude-subagent-linkage'

function streamScope(frame: Record<string, unknown>): string | null {
  const event = claudeRecord(frame.event)
  const sessionId = claudeText(frame.session_id)
  if (frame.type !== 'stream_event' || event?.type !== 'message_start' || !sessionId) {
    return null
  }
  return `${sessionId}/${claudeText(frame.parent_tool_use_id) ?? ''}`
}

export type ClaudeStreamedThinking = ReturnType<typeof createClaudeStreamedThinking>

export type ClaudeReasoningFinal = {
  identity: AgentJournalItemIdentity
  body: AgentJournalMessageItem
  startedAt?: number
}

/** Keep thinking deltas and their final frame on one row until finalization or turn end. */
export function createClaudeStreamedThinking(deps: {
  sink: StructuredAgentSessionEventSink
  producer: ClaudeSubagentLinkageSource
  turnScope: () => AgentJournalTurnScope
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}) {
  const blocks = createClaudeStreamedBlockRegistry('thinking')
  const open = new Map<string, { scope: string; startedAt: number }>()
  const checkpoints = createClaudeStreamedTextCheckpoints({
    ...(deps.coalesceMs === undefined ? {} : { coalesceMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    producer: deps.producer,
    persist: (identity, text, options, ended) => {
      const body = journalReasoningBody(
        text,
        ended ? endedJournalReasoning(ended.completedAt) : { state: 'running' }
      )
      if (body) {
        const startedAt = open.get(agentJournalItemKey(identity))?.startedAt
        deps.sink.appendItem(identity, body, {
          ...options,
          turnScope: deps.turnScope(),
          // Preserve block start time despite delayed text or writes.
          ...(startedAt === undefined ? {} : { observedAt: startedAt }),
          // Preserve terminal writes under pressure so reasoning cannot remain open.
          ...(ended ? { lifecycle: true } : {})
        })
        deps.sink.publish()
      }
    }
  })
  const finish = (ended: ClaudeStreamedBlockEnd, scope?: string): void => {
    checkpoints.finish(
      ended,
      scope === undefined ? undefined : (key) => open.get(key)?.scope === scope
    )
    for (const [key, block] of open) {
      if (scope === undefined || block.scope === scope) {
        open.delete(key)
      }
    }
  }

  return {
    observe: (frame: Record<string, unknown>, observedAt: number): boolean => {
      // A new message abandons unfinished blocks in the same stream.
      const restarted = streamScope(frame)
      if (restarted !== null) {
        finish({ completedAt: observedAt }, restarted)
      }
      const delta = blocks.observe(frame, observedAt)
      if (!delta) {
        return false
      }
      const identity = delta.identity
      if (identity.provider === 'claude') {
        open.set(agentJournalItemKey(identity), {
          scope: `${identity.sessionId}/${delta.parentToolUseId ?? ''}`,
          startedAt: delta.startedAt
        })
      }
      checkpoints.append(identity, delta.text, delta.parentToolUseId)
      return true
    },
    /** Close the streamed row if present; only streaming gives us an observed end time. */
    finalize: (
      envelope: ClaudeMessageEnvelope,
      observedAt: number
    ): ClaudeReasoningFinal | null => {
      if (!envelope.content.some((part) => claudeRecord(part)?.type === 'thinking')) {
        return null
      }
      const streamed = blocks.reconcile(envelope)
      const identity =
        streamed?.identity ?? claudeThinkingIdentity(envelope.sessionId, envelope.uuid)
      const key = agentJournalItemKey(identity)
      // A textless final frame still closes its streamed row.
      const text = claudeThinkingText(envelope) ?? checkpoints.latest(key) ?? ''
      checkpoints.forget(key)
      open.delete(key)
      const body = journalReasoningBody(
        text,
        endedJournalReasoning(streamed ? observedAt : undefined)
      )
      return body
        ? { identity, body, ...(streamed ? { startedAt: streamed.startedAt } : {}) }
        : null
    },
    finishOpen: (completedAt: number): void => {
      finish({ completedAt })
      blocks.clear()
    },
    flush: checkpoints.flush,
    reattribute: checkpoints.reattribute,
    dispose: (): void => {
      blocks.clear()
      open.clear()
      checkpoints.dispose()
    },
    get pending() {
      return checkpoints.pending
    }
  }
}
