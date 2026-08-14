import { normalizePromptField } from '../../shared/agent-status-field-normalization'
import { addPreviewContent } from './session-scanner-accumulator'
import type { SessionAccumulator } from './session-scanner-types'
import { asRecord, extractContentText, extractPreviewContentText } from './session-scanner-values'

export function consumeCodexResponseMessage(
  accumulator: SessionAccumulator,
  payload: Record<string, unknown>,
  timestamp: unknown
): boolean {
  accumulator.messageCount++
  const role =
    payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : 'unknown'
  const setTitle = role === 'user' && !accumulator.title
  if (setTitle) {
    accumulator.title = extractContentText(payload.content)
  }
  addPreviewContent(accumulator, role, payload.content, timestamp)
  return setTitle && Boolean(accumulator.title)
}

export function consumeCodexCompletedMessage(
  accumulator: SessionAccumulator,
  payload: Record<string, unknown>,
  timestamp: unknown
): boolean {
  const item = asRecord(payload.item)
  if (!item) {
    return false
  }
  const isUser = item.type === 'UserMessage' || item.type === 'user_message'
  const isAssistant = item.type === 'AgentMessage' || item.type === 'agent_message'
  if (!isUser && !isAssistant) {
    return false
  }
  accumulator.messageCount++
  const setTitle = isUser && !accumulator.title
  if (isUser) {
    const prompt = normalizePromptField(extractPreviewContentText(item.content))
    if (prompt) {
      accumulator.lastUserPrompt = prompt
    }
    if (setTitle) {
      accumulator.title = extractContentText(item.content)
    }
  }
  addPreviewContent(accumulator, isUser ? 'user' : 'assistant', item.content, timestamp)
  return setTitle && Boolean(accumulator.title)
}

export function consumeCodexLegacyEventMessage(
  accumulator: SessionAccumulator,
  payload: Record<string, unknown>,
  timestamp: unknown
): boolean {
  const isUser = payload.type === 'user_message'
  accumulator.messageCount++
  const setTitle = isUser && !accumulator.title
  if (isUser) {
    const prompt = normalizePromptField(payload.message)
    if (prompt) {
      accumulator.lastUserPrompt = prompt
    }
    if (setTitle) {
      accumulator.title = extractContentText(payload.message)
    }
  }
  addPreviewContent(accumulator, isUser ? 'user' : 'assistant', payload.message, timestamp)
  return setTitle && Boolean(accumulator.title)
}
