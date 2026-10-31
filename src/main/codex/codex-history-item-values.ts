import { toolExecutionMetadata } from '../../shared/native-chat/tools/native-chat-tool-identity'
import {
  codexCommandOutput,
  codexMessageBlocks,
  codexReasoningText,
  mcpToolArguments,
  mcpToolOutput,
  type CodexThreadItem
} from './codex-structured-item-translation'
import { readReceiverThreadIds, readCodexCollabStates } from './codex-collab-agent-tool-call'
import { imagePath, generatedImageUrl } from './codex-image-item-translation'
import { readRecord, readString, readTextContent } from './codex-item-field-readers'

import { HISTORY_ASSOCIATION, HISTORY_ITEM_TIMINGS } from './codex-history-source-facts'
function copyKnown(
  source: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((key) => source[key] != null).map((key) => [key, source[key]])
  )
}

/** Canonical spellings use the same semantic readers as the live pure projection. */
export function historySourceItem(item: CodexThreadItem): CodexThreadItem | null {
  if (
    (item.type === 'userMessage' || item.type === 'agentMessage') &&
    item.role !== undefined &&
    item.role !== (item.type === 'userMessage' ? 'user' : 'assistant')
  ) {
    return null
  }
  let payload: Record<string, unknown>
  switch (item.type) {
    case 'userMessage':
    case 'agentMessage': {
      payload = copyKnown(item, ['clientId', 'delivery', 'questions'])
      const blocks = codexMessageBlocks(item)
      if (
        blocks.length ||
        (item.type === 'userMessage' && (item.text !== undefined || item.content !== undefined))
      ) {
        payload.content = blocks.map((block) =>
          block.type === 'text'
            ? { type: 'text', text: block.text }
            : block.type === 'image-ref'
              ? block.path
                ? { type: 'localImage', path: block.path }
                : { type: 'image', url: block.url }
              : block
        )
      }
      break
    }
    case 'plan': {
      const text = readTextContent(item, 'text')
      payload = text === null ? {} : { text }
      break
    }
    case 'reasoning': {
      const text = codexReasoningText(item)
      payload = text === null ? {} : { text }
      break
    }
    case 'commandExecution': {
      const output = codexCommandOutput(item)
      payload = {
        ...copyKnown(item, ['command', 'cwd', 'commandActions']),
        ...toolExecutionMetadata(item),
        ...(output === null ? {} : { aggregatedOutput: output })
      }
      break
    }
    case 'mcpToolCall': {
      const output = mcpToolOutput(item)
      const error = readString(readRecord(item.error), 'message')
      payload = {
        ...copyKnown(item, ['server', 'tool']),
        ...(item.arguments !== undefined ? { arguments: mcpToolArguments(item.arguments) } : {}),
        ...(output === null
          ? {}
          : error === null
            ? { result: { content: [{ type: 'text', text: output }] } }
            : { error: { message: output } })
      }
      break
    }
    case 'fileChange':
      payload = copyKnown(item, ['changes'])
      break
    case 'webSearch': {
      const action = readRecord(item.action)
      payload = {
        ...copyKnown(item, ['action', 'results']),
        ...((typeof item.query === 'string' && item.query.length) ||
        typeof action.query === 'string'
          ? {
              query: typeof item.query === 'string' && item.query.length ? item.query : action.query
            }
          : {})
      }
      break
    }
    case 'imageView': {
      const path = imagePath(item, 'path')
      payload = path === null ? {} : { path }
      break
    }
    case 'imageGeneration': {
      const savedPath = imagePath(item, 'savedPath'),
        result = generatedImageUrl(item)
      payload = {
        ...(savedPath === null ? {} : { savedPath }),
        ...(result === null ? {} : { result }),
        ...(item.failure ? { failure: true } : {})
      }
      break
    }
    case 'collabAgentToolCall': {
      const receivers = readReceiverThreadIds(item)
      const states = readCodexCollabStates(item)
      payload = {
        ...copyKnown(item, ['tool', 'prompt', 'model', 'reasoningEffort']),
        ...(Array.isArray(item.receiverThreadIds) ? { receiverThreadIds: receivers } : {}),
        ...(item.agentsStates == null
          ? {}
          : {
              agentsStates: Object.fromEntries(
                states.map((state) => [
                  state.threadId,
                  {
                    ...(state.status === null ? {} : { status: state.status }),
                    ...(state.message === null ? {} : { message: state.message })
                  }
                ])
              )
            })
      }
      break
    }
    case 'subAgentActivity':
      payload = copyKnown(item, ['kind', 'agentThreadId', 'agentPath'])
      break
    case 'contextCompaction':
      payload = {}
      break
    default:
      return null
  }
  const times = Object.fromEntries(
    HISTORY_ITEM_TIMINGS.filter(
      (key) =>
        typeof item[key] === 'number' &&
        Number.isFinite(item[key]) &&
        (!key.startsWith('completed') || item[key] !== 0)
    ).map((key) => [key, item[key]])
  )
  return {
    type: item.type,
    id: item.id,
    ...copyKnown(item, [...HISTORY_ASSOCIATION, 'threadId', 'turnId', 'status']),
    ...times,
    ...payload
  }
}
