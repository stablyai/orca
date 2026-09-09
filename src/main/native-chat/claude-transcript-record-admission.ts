import type { NativeChatTextBlock } from '../../shared/native-chat-types'
import { asRecord, extractString } from '../ai-vault/session-scanner-values'
import { readableProviderFrameText } from './agent-session-wire/unhandled-provider-frame'
import { claudeContentBlocks } from './transcript-record-blocks'

type ClaudeTranscriptRecordAdmission =
  | { kind: 'message'; role: 'user' | 'assistant' }
  | { kind: 'queued-prompt'; blocks: NativeChatTextBlock[] }
  | { kind: 'notice'; blocks: NativeChatTextBlock[] }
  | { kind: 'ignored' }

// Persisted bookkeeping has different ownership from structured live frames.
const BOOKKEEPING_SUBTYPES = new Set([
  'stop_hook_summary',
  'turn_duration',
  'away_summary',
  'local_command',
  'hook_callback',
  'init',
  'compact_boundary'
])

function queuedPrompt(record: Record<string, unknown>): ClaudeTranscriptRecordAdmission {
  const attachment = asRecord(record.attachment)
  if (attachment?.type !== 'queued_command' || attachment.commandMode !== 'prompt') {
    return { kind: 'ignored' }
  }
  const text = extractString(attachment.prompt)
  return text ? { kind: 'queued-prompt', blocks: [{ type: 'text', text }] } : { kind: 'ignored' }
}

function systemNotice(record: Record<string, unknown>): ClaudeTranscriptRecordAdmission {
  if (BOOKKEEPING_SUBTYPES.has(String(record.subtype))) {
    return { kind: 'ignored' }
  }
  const content = record.content ?? asRecord(record.message)?.content
  const text =
    claudeContentBlocks(content)
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n') || readableProviderFrameText(record)
  if (!text?.trim()) {
    return { kind: 'ignored' }
  }
  const tone = record.level === 'error' || record.level === 'warning' ? record.level : 'notice'
  return { kind: 'notice', blocks: [{ type: 'text', text, tone }] }
}

/** Admit provider records by meaning before mapping them into chat roles. */
export function classifyClaudeTranscriptRecord(
  record: Record<string, unknown>
): ClaudeTranscriptRecordAdmission {
  switch (record.type) {
    case 'user':
    case 'assistant':
      return { kind: 'message', role: record.type }
    case 'attachment':
      return queuedPrompt(record)
    case 'system':
      return systemNotice(record)
    default:
      return { kind: 'ignored' }
  }
}
