// Match Codex hook tool names so structured and CLI child rows use the same vocabulary.
import { ownRetainedString } from '../../shared/own-retained-string'
import type { AgentChildWorkOutcome } from '../../shared/agent-status-child-work'
import type { NativeChatSubagentState } from '../../shared/native-chat-types'
import {
  deriveFallbackToolInputPreview,
  deriveToolInputPreview
} from '../../shared/agent-hook-listener/tool-input-preview'
import { readRecord, readString, readTextContent } from './codex-item-field-readers'
import type { CodexThreadItem } from './codex-structured-item-translation'

/** Raw provider text kept for a record; admission folds it to its own one-line bound. */
export const CODEX_CHILD_WORK_TEXT_MAX_CHARS = 2_048

export type CodexChildToolCall = { toolName: string; input?: string }

function bounded(text: string | null | undefined): string | undefined {
  if (!text) {
    return undefined
  }
  return text.length > CODEX_CHILD_WORK_TEXT_MAX_CHARS
    ? ownRetainedString(text.slice(0, CODEX_CHILD_WORK_TEXT_MAX_CHARS))
    : text
}

function withInput(toolName: string, input: string | undefined): CodexChildToolCall {
  const preview = bounded(input)
  return preview ? { toolName, input: preview } : { toolName }
}

function firstChangePath(changes: unknown): string | undefined {
  const [first] = Array.isArray(changes) ? changes : []
  return readString(readRecord(first), 'path') ?? undefined
}

export function codexChildToolCall(item: CodexThreadItem): CodexChildToolCall | null {
  switch (item.type) {
    case 'commandExecution':
      return withInput('Bash', deriveToolInputPreview('Bash', { command: item.command }))
    case 'fileChange':
      return withInput('apply_patch', firstChangePath(item.changes))
    case 'mcpToolCall': {
      const server = readString(item, 'server')
      const tool = readString(item, 'tool')
      if (!tool) {
        return null
      }
      return withInput(
        server ? `mcp__${server}__${tool}` : tool,
        deriveFallbackToolInputPreview(item.arguments)
      )
    }
    case 'webSearch':
      return withInput('web_search', readString(item, 'query') ?? undefined)
    default:
      return null
  }
}

export function codexToolCallEnded(method: string, item: CodexThreadItem): boolean {
  const status = readString(item, 'status')
  return method === 'item/completed' || (status !== null && status !== 'inProgress')
}

export function codexChildMessageText(item: CodexThreadItem): string | undefined {
  return item.type === 'agentMessage'
    ? bounded(readString(item, 'text') ?? readTextContent(item, 'content'))
    : undefined
}

export function codexChildTurnOutcome(state: NativeChatSubagentState): AgentChildWorkOutcome {
  switch (state) {
    case 'completed':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'cancelled'
    case 'unverifiable':
    case 'working':
    case 'idle':
      return 'unknown'
  }
}
