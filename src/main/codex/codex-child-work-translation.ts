// Codex items and statuses, read in the child-work vocabulary.
//
// A tool is named the way Codex names it to its own hooks (`Bash`, `apply_patch`,
// `mcp__server__tool`), so a structured Codex child running a shell reads exactly as a Codex
// CLI agent running one does.

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
  return text ? text.slice(0, CODEX_CHILD_WORK_TEXT_MAX_CHARS) : undefined
}

function withInput(toolName: string, input: string | undefined): CodexChildToolCall {
  const preview = bounded(input)
  return preview ? { toolName, input: preview } : { toolName }
}

function firstChangePath(changes: unknown): string | undefined {
  const [first] = Array.isArray(changes) ? changes : []
  return readString(readRecord(first), 'path') ?? undefined
}

/** The tool a thread item runs, or null for an item that is not a tool call (a message, a
 *  thought, a plan). A persistent command is not one either: it is work of its own. */
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

/** Whether an item frame says the call is over, whatever frame carried it. */
export function codexToolCallEnded(method: string, item: CodexThreadItem): boolean {
  const status = readString(item, 'status')
  return method === 'item/completed' || (status !== null && status !== 'inProgress')
}

/** What a child said: an assistant message's text. */
export function codexChildMessageText(item: CodexThreadItem): string | undefined {
  return item.type === 'agentMessage'
    ? bounded(readString(item, 'text') ?? readTextContent(item, 'content'))
    : undefined
}

/** A child turn's ending. Codex states three; anything else is an ending nobody classified. */
export function codexChildTurnOutcome(state: NativeChatSubagentState): AgentChildWorkOutcome {
  switch (state) {
    case 'completed':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

/** A persistent command's exit: a zero (or unreported) exit code is the only success, as the
 *  command's own transcript row reads it; a declined command never ran. */
export function codexCommandOutcome(item: CodexThreadItem): AgentChildWorkOutcome {
  switch (readString(item, 'status')) {
    case 'completed':
      return typeof item.exitCode === 'number' && item.exitCode !== 0 ? 'failed' : 'succeeded'
    case 'failed':
      return 'failed'
    case 'declined':
      return 'cancelled'
    default:
      return 'unknown'
  }
}
