import type {
  CodexItemStreamDeps,
  CodexStructuredItemStreams
} from './codex-structured-item-stream-contracts'
import { appendCodexLifecycleItem, publishCodexLifecycle } from './codex-structured-journal-sink'
import {
  endedRunningAgentJournalToolCall,
  type AgentJournalRunningCallEnd
} from '../../shared/agent-journal-tool-call-lifecycle'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { cancelledJournalPromptBody } from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import {
  endedJournalReasoning,
  type JournalReasoningLifecycle,
  withJournalReasoningLifecycle
} from '../native-chat/agent-session-journal/journal-reasoning-row'
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

export function withCodexItemLifecycle(
  translated: ReturnType<typeof codexJournalItem>,
  lifecycle: JournalReasoningLifecycle
): ReturnType<typeof codexJournalItem> {
  return translated.body
    ? { ...translated, body: withJournalReasoningLifecycle(translated.body, lifecycle) }
    : translated
}

export function settleEvictedCodexItem(
  deps: Pick<CodexItemStreamDeps, 'sink' | 'attributionFor'>,
  active: CodexActiveJournalItem,
  streams: Pick<CodexStructuredItemStreams, 'snapshot'>
) {
  const body = deps.sink.textSource?.(active.identity)
    ? null
    : interruptedCodexItemBody(codexActiveItemBody(active, streams))
  if (!body) {
    return { accepted: true as const }
  }
  const admission = appendCodexLifecycleItem(deps.sink, active.identity, body, {
    ...deps.attributionFor(active.threadId, active.turnId),
    ...(active.startedAt === undefined ? {} : { observedAt: active.startedAt })
  })
  return admission.accepted ? publishCodexLifecycle(deps.sink) : admission
}
