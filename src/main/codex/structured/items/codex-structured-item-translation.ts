import {
  finishTranscriptWork,
  type TranscriptWork
} from '../../../native-chat/transcript-work-scheduler'
import { codexMessageBlocksWork } from './codex-message-blocks'
export { codexMessageBlocks } from './codex-message-blocks'
import {
  codexCommandOutput,
  codexReasoningTextWork,
  mcpToolArguments,
  mcpToolOutputWork
} from './codex-item-result-readers'
import {
  toolExecutionMetadata,
  toolWebSearchResults
} from '../../../../shared/native-chat/tools/native-chat-tool-identity'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatBlock } from '../../../../shared/native-chat/native-chat-types'
import { CODEX_ASYNC_QUESTION_TOOL } from '../../../../shared/codex-async-question-input'
import { journalPayload } from '../../../native-chat/agent-session-journal/item-lifecycle/journal-payload-bounds'
import { unhandledProviderFrameJournalItem } from '../../../native-chat/agent-session-wire/providers/unhandled-provider-frame'
import { codexImageItemBody } from './codex-image-item-translation'
import { commandActionFacts } from './codex-command-action-class'
import {
  codexCollabAgentToolCallBody,
  type CodexHelperName
} from './codex-collab-agent-item-translation'
import { codexItemRunState } from './codex-item-run-state'
import {
  readRecord,
  readString,
  readTextContentWork
} from '../../app-server/codex-item-field-readers'
import type { CodexThreadItem } from './codex-thread-item-identity'
import { journalReasoningBody } from '../../../native-chat/agent-session-journal/item-lifecycle/journal-reasoning-row'

/** The message text displays the question; this call block enables replies. */
function codexAsyncQuestionBlock(item: CodexThreadItem): NativeChatBlock | null {
  if (item.type !== 'agentMessage' || item.delivery !== 'async' || !Array.isArray(item.questions)) {
    return null
  }
  return {
    type: 'tool-call',
    name: CODEX_ASYNC_QUESTION_TOOL,
    callId: item.id,
    input: { questions: item.questions }
  }
}

export type CodexJournalItem = {
  body: AgentJournalItemBody | null
  handled: boolean
}

function commandItem(item: CodexThreadItem): CodexJournalItem {
  const output = codexCommandOutput(item)
  const parsed = commandActionFacts(item)
  return {
    body: {
      kind: 'tool-call',
      name: parsed?.name ?? 'shell',
      callId: item.id,
      // Preserve raw execution details alongside the classified label.
      input: { command: item.command ?? null, cwd: item.cwd ?? null, ...parsed?.fields },
      state: codexItemRunState(item),
      ...toolExecutionMetadata(item),
      ...(output === null ? {} : { output: journalPayload(output) })
    },
    handled: true
  }
}

function fileChangeToolCall(item: CodexThreadItem, output?: string): CodexJournalItem {
  return {
    body: {
      kind: 'tool-call',
      name: 'apply_patch',
      callId: item.id,
      input: { changes: item.changes ?? null },
      state: codexItemRunState(item),
      ...(output === undefined ? {} : { output: journalPayload(output) })
    },
    handled: true
  }
}

function* fileChangeItemWork(item: CodexThreadItem): TranscriptWork<CodexJournalItem> {
  const changes: { path: string; diff: string }[] = []
  for (const change of Array.isArray(item.changes) ? item.changes : []) {
    yield 1
    const record = typeof change === 'object' && change !== null ? readRecord(change) : {}
    const path = readString(record, 'path')
    const diff = readString(record, 'diff')
    if (path && diff) {
      changes.push({ path, diff })
    }
  }
  if (changes.length === 0 || codexItemRunState(item) !== 'completed') {
    return fileChangeToolCall(item)
  }
  const parts: string[] = []
  for (const change of changes) {
    yield 1
    parts.push(change.diff)
  }
  const patch = parts.join('\n')
  return {
    body: {
      kind: 'diff',
      path: changes.length === 1 ? changes[0]!.path : `${changes.length} files`,
      patch: journalPayload(patch)
    },
    handled: true
  }
}

/** Preserve names for exact dispatch; qualify by server to avoid tool collisions. */
function mcpToolCallName(item: CodexThreadItem): string {
  const tool = readString(item, 'tool')
  const server = readString(item, 'server')
  return tool === null ? 'mcp' : server === null ? tool : `${server}/${tool}`
}

/** Labels read top-level keys; wrap non-object arguments and omit empty objects. */
function* mcpToolCallItemWork(item: CodexThreadItem): TranscriptWork<CodexJournalItem> {
  const server = readString(item, 'server')
  const tool = readString(item, 'tool')
  const failure = readString(readRecord(item.error), 'message')
  const text = yield* mcpToolOutputWork(item)
  return {
    body: {
      kind: 'tool-call',
      name: mcpToolCallName(item),
      callId: item.id,
      ...(server && tool ? { mcpIdentity: { server, tool } } : {}),
      input: mcpToolArguments(item.arguments),
      state: failure === null ? codexItemRunState(item) : 'failed',
      ...(text === null ? {} : { output: journalPayload(text) })
    },
    handled: true
  }
}

/** Hoist action fields for labels; description is the lowest-priority fallback. */
function webSearchInput(item: CodexThreadItem): Record<string, unknown> | null {
  const action = readRecord(item.action)
  const fields: [string, unknown][] = [
    ['url', readString(action, 'url')],
    ['pattern', readString(action, 'pattern')],
    ['description', readString(action, 'type')],
    ['action', item.action ?? null]
  ]
  const query = readString(item, 'query') ?? readString(action, 'query')
  const present = fields.filter(([, value]) => value !== null)
  // A blank query prevents the run header from falling back to raw JSON.
  return query === null && present.length === 0
    ? null
    : { query: query ?? '', ...Object.fromEntries(present) }
}

/** Web search has no status; action presence signals completion even when query is empty. */
function webSearchItem(item: CodexThreadItem): CodexJournalItem {
  const results = toolWebSearchResults(item.results)
  const hits = Array.isArray(item.results) && item.results.length > 0 ? item.results : null
  return {
    body: {
      kind: 'tool-call',
      name: 'web_search',
      callId: item.id,
      ...(results.length > 0 ? { webSearchResults: results } : {}),
      input: webSearchInput(item),
      state: item.action === null || item.action === undefined ? 'running' : 'completed',
      ...(hits === null ? {} : { output: journalPayload(JSON.stringify(hits)) })
    },
    handled: true
  }
}

/** Unknown items get bounded status rows; started supplies the earlier revision of a finished item. */
export function codexJournalItem(
  item: CodexThreadItem,
  helperName?: CodexHelperName,
  started?: CodexThreadItem
): CodexJournalItem {
  return finishTranscriptWork(codexJournalItemWork(item, helperName, started))
}

export function* codexJournalItemWork(
  item: CodexThreadItem,
  helperName?: CodexHelperName,
  started?: CodexThreadItem
): TranscriptWork<CodexJournalItem> {
  if (item.type === 'userMessage' || item.type === 'agentMessage') {
    const question = codexAsyncQuestionBlock(item)
    const blocks = yield* codexMessageBlocksWork(item)
    if (question) {
      blocks.push(question)
    }
    return {
      body:
        blocks.length === 0
          ? null
          : { kind: 'message', role: item.type === 'userMessage' ? 'user' : 'assistant', blocks },
      handled: true
    }
  }
  if (item.type === 'commandExecution') {
    return commandItem(item)
  }
  if (item.type === 'fileChange') {
    return yield* fileChangeItemWork(item)
  }
  if (item.type === 'mcpToolCall') {
    return yield* mcpToolCallItemWork(item)
  }
  if (item.type === 'webSearch') {
    return webSearchItem(item)
  }
  if (item.type === 'imageView' || item.type === 'imageGeneration') {
    return { body: codexImageItemBody(item), handled: true }
  }
  const collab = codexCollabAgentToolCallBody(item, helperName, started)
  if (collab) {
    return { body: collab, handled: true }
  }
  if (item.type === 'plan') {
    const text = yield* readTextContentWork(item, 'text')
    return {
      body:
        text === null
          ? null
          : {
              kind: 'status',
              text,
              presentation: 'plan-document'
            },
      handled: true
    }
  }
  if (item.type === 'reasoning') {
    const text = yield* codexReasoningTextWork(item)
    return { body: journalReasoningBody(text), handled: true }
  }
  const unhandled = unhandledProviderFrameJournalItem('codex', `item:${item.type}`, item)
  return unhandled ? { body: unhandled.body, handled: false } : { body: null, handled: true }
}

export function codexItemBody(item: CodexThreadItem): AgentJournalItemBody | null {
  return codexJournalItem(item).body
}

export function codexStreamingMessageBody(text: string): AgentJournalItemBody {
  return {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text }]
  }
}

export function codexStreamingJournalItem(item: CodexThreadItem, text: string): CodexJournalItem {
  if (item.type === 'agentMessage') {
    return { body: codexStreamingMessageBody(text), handled: true }
  }
  if (item.type === 'reasoning') {
    return { body: journalReasoningBody(text), handled: true }
  }
  if (item.type === 'commandExecution') {
    return commandItem({ ...item, aggregatedOutput: text })
  }
  if (item.type === 'fileChange') {
    return fileChangeToolCall(item, text)
  }
  if (item.type === 'plan') {
    return {
      body: {
        kind: 'status',
        text,
        presentation: 'plan-document'
      },
      handled: true
    }
  }
  return {
    body: { kind: 'status', text },
    handled: true
  }
}
