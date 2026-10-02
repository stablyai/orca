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
import type { AgentSessionOpenReasoning } from '../../shared/agent-session-wire'
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

/** The stream a frame belongs to, which a new message in it starts over. */
function streamScope(frame: Record<string, unknown>): string | null {
  const event = claudeRecord(frame.event)
  const sessionId = claudeText(frame.session_id)
  if (frame.type !== 'stream_event' || event?.type !== 'message_start' || !sessionId) {
    return null
  }
  return `${sessionId}/${claudeText(frame.parent_tool_use_id) ?? ''}`
}

export type ClaudeStreamedThinking = ReturnType<typeof createClaudeStreamedThinking>

/** A thinking block's closing row, and when the block began if it was seen streaming. */
export type ClaudeReasoningFinal = {
  identity: AgentJournalItemIdentity
  body: AgentJournalMessageItem
  startedAt?: number
}

/** The reasoning tracker for Claude: every thinking block streamed under --include-partial-messages
 *  is open from its `content_block_start` (blank blocks too) until its final assistant frame, its
 *  `content_block_stop`, a new message in its stream, or the turn's end. The row a block's text
 *  writes and the live "reasoning open" signal both read that one set. */
export function createClaudeStreamedThinking(deps: {
  sink: StructuredAgentSessionEventSink
  producer: ClaudeSubagentLinkageSource
  turnScope: () => AgentJournalTurnScope
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}) {
  const blocks = createClaudeStreamedBlockRegistry('thinking')
  /** Each open block's stream and producer, and when it began. */
  const open = new Map<
    string,
    { scope: string; parentToolUseId: string | null; startedAt: number }
  >()
  /** Blocks a stop ended before their final frame, which keeps that end. */
  const stopped = new Map<string, { scope: string; at: number }>()
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
          // The row starts with its block, not with its first text or a queued write.
          ...(startedAt === undefined ? {} : { observedAt: startedAt }),
          // An end the sink sheds under pressure would leave the row open with nothing to close it.
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
    for (const [key, block] of stopped) {
      if (scope === undefined || block.scope === scope) {
        stopped.delete(key)
      }
    }
  }

  return {
    /** True when the frame carried thinking text. */
    observe: (frame: Record<string, unknown>, observedAt: number): boolean => {
      // A new message in a stream means the previous one's unfinished blocks are never finishing.
      const restarted = streamScope(frame)
      if (restarted !== null) {
        finish({ completedAt: observedAt }, restarted)
      }
      const event = blocks.observeBlock(frame, observedAt)
      if (!event) {
        return false
      }
      const key = agentJournalItemKey(event.identity)
      const scope = `${sessionScopeOf(event.identity)}/${event.parentToolUseId ?? ''}`
      if (event.kind === 'stop') {
        // Normally the final frame closed it already; this is the end an interrupted block gets.
        if (open.has(key)) {
          checkpoints.finish({ completedAt: observedAt }, (candidate) => candidate === key)
          open.delete(key)
          stopped.set(key, { scope, at: observedAt })
        }
        return false
      }
      if (!open.has(key)) {
        open.set(key, {
          scope,
          parentToolUseId: event.parentToolUseId,
          startedAt: event.startedAt
        })
      }
      if (!event.text) {
        return false
      }
      checkpoints.append(event.identity, event.text, event.parentToolUseId)
      return true
    },
    /** The row a final frame's thinking lands on — its streamed block's, else its own — closed.
     *  Only a block seen streaming has an observed end. A blank final writes no row but still
     *  closes its block. */
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
      // A final frame with no text of its own still ends the row its stream wrote.
      const text = claudeThinkingText(envelope) ?? checkpoints.latest(key) ?? ''
      const endedAt = stopped.get(key)?.at ?? observedAt
      checkpoints.forget(key)
      open.delete(key)
      stopped.delete(key)
      const body = journalReasoningBody(text, endedJournalReasoning(streamed ? endedAt : undefined))
      return body
        ? { identity, body, ...(streamed ? { startedAt: streamed.startedAt } : {}) }
        : null
    },
    /** Who has a thinking block open right now: the session's own agent, and each subagent by the
     *  producer id its rows carry. */
    openReasoning: (): AgentSessionOpenReasoning => {
      let session = false
      const subagents: string[] = []
      for (const block of open.values()) {
        if (block.parentToolUseId === null) {
          session = true
          continue
        }
        // Generic over scope, but the CLI (2.1.280) sends subagent thinking only as finished frames,
        // so on the real CLI this list stays empty.
        const agentId = deps.producer.settledLinkageFor(block.parentToolUseId).linkage.agentId
        if (agentId) {
          subagents.push(agentId)
        }
      }
      return { session, subagents }
    },
    /** End every block still open, for a turn that is ending. */
    finishOpen: (completedAt: number): void => {
      finish({ completedAt })
      blocks.clear()
    },
    flush: checkpoints.flush,
    reattribute: checkpoints.reattribute,
    dispose: (): void => {
      blocks.clear()
      open.clear()
      stopped.clear()
      checkpoints.dispose()
    },
    get pending() {
      return checkpoints.pending
    }
  }
}

function sessionScopeOf(identity: AgentJournalItemIdentity): string {
  return identity.provider === 'claude' ? identity.sessionId : ''
}
