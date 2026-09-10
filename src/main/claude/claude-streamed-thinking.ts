import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import { createClaudeStreamedBlockRegistry } from './claude-streamed-block-identity'
import { createClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'
import type { ClaudeJournalTranslatorDeps } from './claude-structured-journal-translation'
import {
  claudeRecord,
  claudeThinkingIdentity,
  claudeThinkingText,
  type ClaudeMessageEnvelope
} from './claude-structured-item-translation'

function reasoningBody(text: string): AgentJournalMessageItem | null {
  return text.trim()
    ? {
        kind: 'message',
        role: 'reasoning',
        blocks: [{ type: 'text', text: boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }]
      }
    : null
}

export function createClaudeStreamedThinking(deps: ClaudeJournalTranslatorDeps) {
  const blocks = createClaudeStreamedBlockRegistry('thinking')
  const checkpoints = createClaudeStreamedTextCheckpoints({
    ...(deps.coalesceMs === undefined ? {} : { coalesceMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    persist: (identity, text) => {
      const body = reasoningBody(text)
      if (body) {
        deps.sink.appendItem(identity, body)
        deps.sink.publish()
      }
    }
  })

  return {
    observe: (frame: Record<string, unknown>): boolean => {
      const delta = blocks.observe(frame)
      if (delta) {
        checkpoints.append(delta.identity, delta.text)
      }
      return delta !== null
    },
    finalize: (envelope: ClaudeMessageEnvelope): boolean => {
      if (!envelope.content.some((part) => claudeRecord(part)?.type === 'thinking')) {
        return false
      }
      const identity =
        blocks.reconcile(envelope) ?? claudeThinkingIdentity(envelope.sessionId, envelope.uuid)
      checkpoints.forget(agentJournalItemKey(identity))
      const body = reasoningBody(claudeThinkingText(envelope) ?? '')
      if (body) {
        deps.sink.appendItem(identity, body)
      }
      return body !== null
    },
    flush: checkpoints.flush,
    settle: (): void => {
      blocks.clear()
      checkpoints.settle()
    },
    dispose: (): void => {
      blocks.clear()
      checkpoints.dispose()
    },
    get pending() {
      return checkpoints.pending
    }
  }
}
