import {
  endedRunningAgentJournalToolCall,
  type AgentJournalRunningCallEnd
} from '../../shared/agent-journal-tool-call-lifecycle'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { cancelledJournalPromptBody } from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import {
  endedJournalReasoning,
  withJournalReasoningLifecycle
} from '../native-chat/agent-session-journal/journal-reasoning-row'
import type { CodexStructuredItemStreams } from './codex-structured-item-stream-contracts'
import {
  codexJournalItem,
  codexStreamingJournalItem,
  type CodexJournalItem
} from './codex-structured-item-translation'
import type { CodexActiveJournalItem } from './codex-structured-journal-contracts'

/** Prefer streamed text so unfinished rows retain partial output. */
export function codexActiveItemBody(
  active: CodexActiveJournalItem,
  streams: Pick<CodexStructuredItemStreams, 'snapshot'>
): AgentJournalItemBody | null {
  const streamed = streams.snapshot(active.threadId, active.item.id)
  return (
    streamed
      ? codexStreamingJournalItem(active.item, streamed.text)
      : codexJournalItem(active.item, active.helperName)
  ).body
}

/** Empty reasoning completions still close the row built from streamed text. */
export function codexCompletedItem(
  completed: CodexJournalItem,
  active: CodexActiveJournalItem | undefined,
  streams: Pick<CodexStructuredItemStreams, 'snapshot'>
): CodexJournalItem {
  if (completed.body || !active || active.item.type !== 'reasoning') {
    return completed
  }
  return { body: codexActiveItemBody(active, streams), handled: true }
}

export function interruptedCodexItemBody(
  body: AgentJournalItemBody | null,
  end: { at?: number; call?: AgentJournalRunningCallEnd } = {}
): AgentJournalItemBody | null {
  if (!body) {
    return null
  }
  if (body.kind === 'tool-call') {
    return end.call
      ? endedRunningAgentJournalToolCall(body, end.call)
      : { ...body, state: 'failed' }
  }
  if (body.kind === 'message') {
    return withJournalReasoningLifecycle(body, endedJournalReasoning(end.at))
  }
  if (body.kind === 'diff') {
    return { kind: 'status', text: 'File changes were interrupted before completion.' }
  }
  return (body.kind === 'approval' || body.kind === 'question') &&
    body.resolution.state === 'pending'
    ? (cancelledJournalPromptBody(body) ?? body)
    : body
}
