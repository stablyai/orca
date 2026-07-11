import type { NativeChatMessage } from '../../shared/native-chat-types'
import { asRecord, extractString } from '../ai-vault/session-scanner-values'
import { claudeContentBlocks } from './transcript-record-blocks'

/** Maps a paginated Codex TurnItem into Native Chat's transcript model. */
export function codexTurnItem(
  item: Record<string, unknown>,
  id: string,
  timestamp: number | null
): NativeChatMessage | null {
  const itemType = normalizeCodexTurnItemType(item.type)
  if (itemType === 'user_message') {
    const text = codexTurnItemText(item.content)
    return text
      ? { id, role: 'user', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
      : null
  }
  if (itemType === 'agent_message') {
    const blocks = claudeContentBlocks(item.content)
    const fallbackText = blocks.length === 0 ? codexTurnItemText(item.content) : null
    if (blocks.length === 0 && !fallbackText) {
      return null
    }
    return {
      id,
      role: 'assistant',
      blocks: blocks.length > 0 ? blocks : [{ type: 'text', text: fallbackText! }],
      timestamp,
      source: 'transcript'
    }
  }
  if (itemType === 'reasoning') {
    const text = codexReasoningItemText(item)
    return text
      ? {
          id,
          role: 'reasoning',
          blocks: [{ type: 'text', text }],
          timestamp,
          source: 'transcript'
        }
      : null
  }
  if (itemType === 'command_execution') {
    return {
      id,
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name: 'command_execution',
          input: {
            command: item.command,
            cwd: item.cwd,
            status: item.status,
            exit_code: item.exit_code
          }
        }
      ],
      timestamp,
      source: 'transcript'
    }
  }
  if (itemType === 'dynamic_tool_call' || itemType === 'mcp_tool_call') {
    const name =
      extractString(item.tool) ??
      extractString(item.name) ??
      (itemType === 'mcp_tool_call' ? 'mcp_tool' : 'tool')
    return {
      id,
      role: 'assistant',
      blocks: [{ type: 'tool-call', name, input: item.arguments ?? item.input ?? item }],
      timestamp,
      source: 'transcript'
    }
  }
  return null
}

function codexTurnItemText(content: unknown): string | null {
  if (typeof content === 'string') {
    return extractString(content)
  }
  if (!Array.isArray(content)) {
    const record = asRecord(content)
    return extractString(record?.text) ?? extractString(record?.message)
  }
  const parts: string[] = []
  for (const entry of content) {
    if (typeof entry === 'string') {
      if (entry.trim()) {
        parts.push(entry)
      }
      continue
    }
    const record = asRecord(entry)
    const text = extractString(record?.text) ?? extractString(record?.content)
    if (text) {
      parts.push(text)
    }
  }
  return parts.length > 0 ? parts.join('') : null
}

function codexReasoningItemText(item: Record<string, unknown>): string | null {
  if (Array.isArray(item.summary_text)) {
    const parts = item.summary_text
      .map((entry) => extractString(entry))
      .filter((entry): entry is string => Boolean(entry))
    if (parts.length > 0) {
      return parts.join('\n')
    }
  }
  if (Array.isArray(item.summary)) {
    const parts: string[] = []
    for (const entry of item.summary) {
      const text = extractString(asRecord(entry)?.text) ?? extractString(entry)
      if (text) {
        parts.push(text)
      }
    }
    if (parts.length > 0) {
      return parts.join('\n')
    }
  }
  return extractString(item.text)
}

function normalizeCodexTurnItemType(value: unknown): string | null {
  const raw = extractString(value)
  if (!raw) {
    return null
  }
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}
