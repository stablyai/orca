import { appendClaudePreparedSteps } from './claude-streamed-terminal'
import type { ClaudeStreamedTextDelta } from './claude-streamed-block-identity'
import { appendStructuredAgentSessionTextWindow } from '../native-chat/agent-session-wire/structured-agent-session-text-append'
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
  appendClaudeStreamedWhole,
  createClaudeStreamedTextCheckpoints,
  type ClaudeStreamedBlockEnd,
  type ClaudePreparedTextEnd
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
  holdStream?: (delta: ClaudeStreamedTextDelta, retry: () => boolean) => void
}) {
  const blocks = createClaudeStreamedBlockRegistry('thinking')
  /** Each open block's stream, and when it began. */

  const persistPrepared = (
    block: ClaudePreparedTextEnd,
    ended?: ClaudeStreamedBlockEnd
  ): boolean => {
    if (!block.hasText) {
      return true
    }
    const wholeText = !deps.sink.tryAppendTransition ? block.text : undefined
    const body = journalReasoningBody(
      wholeText ?? (deps.sink.prepareText ? 'x' : (block.text ?? '')),
      ended ? endedJournalReasoning(ended.completedAt) : { state: 'running' }
    )
    const options = {
      ...block.options,
      turnScope: deps.turnScope(),
      ...(block.startedAt === undefined ? {} : { observedAt: block.startedAt })
    }
    return (
      body !== null &&
      (wholeText !== undefined
        ? appendClaudeStreamedWhole(deps.sink, block.identity, body, options)
        : appendClaudePreparedSteps(deps.sink, [block.step(body, options, ended !== undefined)]))
    )
  }

  const checkpoints = createClaudeStreamedTextCheckpoints({
    ...(deps.coalesceMs === undefined ? {} : { coalesceMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    producer: deps.producer,
    source: deps.sink.textSource,
    prepareText: deps.sink.prepareText,
    persistDelta: (identity, window, options) => {
      if (!window.hasText) {
        return true
      }
      const body = journalReasoningBody('x', { state: 'running' })
      if (!body) {
        return true
      }
      const startedAt = checkpoints.startedAt(agentJournalItemKey(identity))
      return appendStructuredAgentSessionTextWindow(deps.sink, identity, body, window, {
        ...options,
        turnScope: deps.turnScope(),
        ...(startedAt === undefined ? {} : { observedAt: startedAt })
      })
    },
    persistPrepared,
    persist: (identity, text, options, ended) => {
      const body = journalReasoningBody(
        text,
        ended ? endedJournalReasoning(ended.completedAt) : { state: 'running' }
      )
      if (body) {
        const startedAt = checkpoints.startedAt(agentJournalItemKey(identity))
        const appendOptions = {
          ...options,
          turnScope: deps.turnScope(),
          // Preserve block start time despite delayed text or writes.
          ...(startedAt === undefined ? {} : { observedAt: startedAt }),
          // Preserve terminal writes under pressure so reasoning cannot remain open.
          ...(ended ? { lifecycle: true } : {})
        }
        if (ended) {
          return appendClaudeStreamedWhole(deps.sink, identity, body, appendOptions)
        }
        deps.sink.appendItem(identity, body, appendOptions)
        deps.sink.publish()
      }
      return undefined
    }
  })
  const finish = (ended: ClaudeStreamedBlockEnd, scope?: string): boolean =>
    checkpoints.finish(
      ended,
      (_, block) =>
        scope === undefined ||
        `${block.identity.provider === 'claude' ? block.identity.sessionId : ''}/${block.scope ?? ''}` ===
          scope
    )

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
      const retry = () =>
        checkpoints.append(identity, delta.text, delta.parentToolUseId, delta.startedAt)
      if (!retry()) {
        deps.holdStream?.(delta, retry)
      }
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
      // A final frame with no text of its own still ends the row its stream wrote.
      const supplied = claudeThinkingText(envelope)
      if (supplied === null && deps.sink.prepareText) {
        checkpoints.finish({ completedAt: observedAt }, (candidate) => candidate === key)
        return null
      }
      const text = supplied ?? checkpoints.latest(key) ?? ''

      const body = journalReasoningBody(
        text,
        endedJournalReasoning(streamed ? observedAt : undefined)
      )
      if (!body) {
        checkpoints.finish({ completedAt: observedAt }, (candidate) => candidate === key)
        return null
      }
      return { identity, body, ...(streamed ? { startedAt: streamed.startedAt } : {}) }
    },
    prepareFinishOpen: (completedAt?: number, extra?: ClaudeStreamedTextDelta) => {
      const pending = checkpoints.prepareFinish(undefined, extra)
      return {
        steps: pending.flatMap((block) => {
          const body = journalReasoningBody(
            block.hasText ? 'x' : '',
            endedJournalReasoning(completedAt)
          )
          return body
            ? [
                block.step(body, {
                  ...block.options,
                  turnScope: deps.turnScope(),
                  ...(block.startedAt === undefined ? {} : { observedAt: block.startedAt })
                })
              ]
            : []
        }),
        accept: () => {
          for (const block of pending) {
            block.forget()
          }
          blocks.clear()
        }
      }
    },
    /** End every block still open, for a turn that is ending. */
    finishOpen: (completedAt?: number): boolean => {
      const accepted = finish({ completedAt })
      if (accepted) {
        blocks.clear()
      }
      return accepted
    },
    forget: (identity: AgentJournalItemIdentity): void => {
      const key = agentJournalItemKey(identity)
      checkpoints.forget(key)
    },
    flush: checkpoints.flush,
    reattribute: checkpoints.reattribute,
    dispose: (): void => {
      blocks.clear()
      checkpoints.dispose()
    },
    get pending() {
      return checkpoints.pending
    }
  }
}
