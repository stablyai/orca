import type {
  ProviderTimelineEvent,
  ProviderTimelineItemBody
} from '../native-chat/agent-session-timeline/provider-timeline-event'
import { journalPayload } from '../native-chat/agent-session-journal/item-lifecycle/journal-payload-bounds'
import {
  toolExecutionMetadata,
  toolWebSearchResults
} from '../../shared/native-chat/tools/native-chat-tool-identity'
import { commandActionFacts } from '../../shared/native-chat/tools/native-chat-command-actions'
import { nativeChatImageItemBody } from '../native-chat/agent-session-timeline/provider-image-item'
import { CODEX_ASYNC_QUESTION_TOOL } from '../../shared/codex-async-question-input'
import { nativeChatAgentToolResultText } from '../../shared/native-chat/tools/native-chat-agent-tool-result'
import {
  CODEX_COLLAB_ROW_AGENTS_KEY,
  codexCollabToolRowName
} from '../../shared/codex-collab-agent-tools'
import type { NativeChatBlock } from '../../shared/native-chat/native-chat-types'
import { traexContentText, traexRecord, traexText, type TraexItem } from './traex-protocol'
import { traexTimelineItemKey } from './traex-timeline-item-key'

export function traexItemBody(
  item: TraexItem,
  completed: boolean
): ProviderTimelineItemBody | null {
  if (item.type === 'contextCompaction') {
    return completed
      ? { kind: 'status', text: 'Context compacted', presentation: 'compaction' }
      : null
  }
  if (item.type === 'subAgentActivity') {
    return null
  }
  if (item.type === 'taskNotification') {
    const notification = traexRecord(item.notification)
    const text = traexText(notification.summary) ?? traexContentText(item.content)
    return text
      ? { kind: 'status', text, tone: notification.status === 'failed' ? 'warning' : 'notice' }
      : null
  }
  if (item.type === 'imageView' || item.type === 'imageGeneration') {
    return nativeChatImageItemBody(item)
  }
  if (item.type === 'terminalInteraction') {
    return {
      kind: 'tool-call',
      name: 'write_stdin',
      callId: item.id,
      input: { session_id: item.processId, chars: item.stdin },
      state: completed ? 'completed' : 'running',
      ...toolExecutionMetadata(item)
    }
  }
  if (item.type === 'collabAgentToolCall') {
    const ids = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter((id): id is string => typeof id === 'string')
      : []
    const description = traexText(item.agentNickname) ?? traexText(item.agentRole) ?? ids.join(', ')
    const result = completed
      ? nativeChatAgentToolResultText({
          tool: traexText(item.tool) ?? '',
          status: traexText(item.status) ?? 'completed',
          receiverThreadIds: ids,
          states: Object.entries(traexRecord(item.agentsStates)).map(([threadId, value]) => {
            const state = traexRecord(value)
            return {
              threadId,
              status: traexText(state.status) ?? null,
              message: traexText(state.message) ?? null
            }
          })
        })
      : null
    return {
      kind: 'tool-call',
      name: codexCollabToolRowName(traexText(item.tool) ?? 'agent'),
      callId: item.id,
      input: {
        prompt: item.prompt,
        [CODEX_COLLAB_ROW_AGENTS_KEY]: ids,
        ...(description ? { description } : {}),
        ...(item.model ? { model: item.model } : {}),
        ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {})
      },
      state: !completed
        ? 'running'
        : ['failed', 'interrupted'].includes(traexText(item.status) ?? '')
          ? 'failed'
          : 'completed',
      ...(result ? { output: journalPayload(result) } : {})
    }
  }
  if (item.type === 'agentMessage' || item.type === 'userMessage' || item.type === 'reasoning') {
    const text =
      item.type === 'reasoning'
        ? traexContentText(item.text) ||
          traexContentText(item.summary) ||
          traexContentText(item.content)
        : (traexText(item.text) ?? traexContentText(item.content))
    return {
      kind: 'message',
      role:
        item.type === 'userMessage'
          ? 'user'
          : item.type === 'reasoning'
            ? 'reasoning'
            : 'assistant',
      blocks: item.type === 'reasoning' ? [{ type: 'text', text }] : traexMessageBlocks(item, text),
      ...(item.type === 'reasoning' ? { state: completed ? 'completed' : 'running' } : {})
    }
  }
  if (
    item.type === 'fileChange' &&
    completed &&
    item.status === 'completed' &&
    Array.isArray(item.changes) &&
    item.changes.length > 0
  ) {
    const changes = item.changes.map(traexRecord)
    return {
      kind: 'diff',
      path: changes.length === 1 ? (traexText(changes[0]?.path) ?? '') : `${changes.length} files`,
      patch: journalPayload(changes.map((change) => traexText(change.diff) ?? '').join('\n'))
    }
  }
  if (
    item.type === 'commandExecution' ||
    item.type === 'mcpToolCall' ||
    item.type === 'dynamicToolCall' ||
    item.type === 'fileChange' ||
    item.type === 'webSearch'
  ) {
    const output =
      traexText(item.aggregatedOutput) ??
      traexContentText(
        item.type === 'dynamicToolCall' ? item.contentItems : traexRecord(item.result).content
      )
    const server = traexText(item.server)
    const tool = traexText(item.tool)
    const action = item.type === 'commandExecution' ? commandActionFacts(item) : null
    const search = traexRecord(item.action)
    const results = item.type === 'webSearch' ? toolWebSearchResults(item.results) : []
    const failure = traexText(traexRecord(item.error).message)
    return {
      kind: 'tool-call',
      name:
        item.type === 'commandExecution'
          ? (action?.name ?? 'shell')
          : item.type === 'fileChange'
            ? 'apply_patch'
            : item.type === 'webSearch'
              ? 'web_search'
              : (tool ?? 'mcp'),
      callId: item.id,
      input:
        item.type === 'commandExecution'
          ? { command: item.command, cwd: item.cwd, ...action?.fields }
          : item.type === 'mcpToolCall' || item.type === 'dynamicToolCall'
            ? item.arguments
            : item.type === 'fileChange'
              ? { changes: item.changes }
              : {
                  query: item.query ?? search.query ?? '',
                  action: item.action,
                  url: search.url,
                  pattern: search.pattern
                },
      state: !completed
        ? 'running'
        : ['failed', 'declined', 'interrupted'].includes(traexText(item.status) ?? '') ||
            item.error != null ||
            item.success === false ||
            (typeof item.exitCode === 'number' && item.exitCode !== 0)
          ? 'failed'
          : 'completed',
      ...toolExecutionMetadata(item),
      ...(server && tool ? { mcpIdentity: { server, tool } } : {}),
      ...(results.length ? { webSearchResults: results } : {}),
      ...(failure || output ? { output: journalPayload(failure ?? output) } : {})
    }
  }
  if (item.type === 'plan') {
    return { kind: 'status', text: traexContentText(item.text), presentation: 'plan-document' }
  }
  return null
}

function traexMessageBlocks(item: TraexItem, text: string): NativeChatBlock[] {
  const blocks: NativeChatBlock[] = [{ type: 'text', text }]
  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      const content = traexRecord(part)
      if (content.type === 'localImage' && typeof content.path === 'string') {
        blocks.push({ type: 'image-ref', path: content.path })
      }
      if (content.type === 'image' && typeof content.url === 'string') {
        blocks.push({ type: 'image-ref', url: content.url })
      }
    }
  }
  if (item.type === 'agentMessage' && item.delivery === 'async' && Array.isArray(item.questions)) {
    blocks.push({
      type: 'tool-call',
      name: CODEX_ASYNC_QUESTION_TOOL,
      callId: item.id,
      input: { questions: item.questions }
    })
  }
  return blocks
}

export function traexItemEvents(
  item: TraexItem,
  threadId: string,
  turnId: string,
  completed: boolean,
  itemKey = traexTimelineItemKey(
    turnId,
    item.type === 'contextCompaction' ? 'contextCompaction' : item.id
  )
): ProviderTimelineEvent[] {
  if ((item.type === 'contextCompaction' && !completed) || item.type === 'subAgentActivity') {
    return []
  }
  const body = traexItemBody(item, completed)
  const join = { thread: threadId, turn: turnId }
  return body
    ? [{ type: completed ? 'item.close' : 'item.open', item: itemKey, body, join }]
    : [{ type: 'provider.frame', frameKind: `item:${item.type}`, payload: item, join }]
}
