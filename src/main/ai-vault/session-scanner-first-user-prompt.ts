import { isKnownHarnessInjectedUserTurnText } from '../../shared/harness-injected-user-turns'
import { getFirstUserPromptCaptureMode } from './session-scanner-first-user-prompt-capture'
import { stripGrokUserQueryEnvelope } from './session-scanner-grok-user-text'
// Direct import: session-scanner-values re-exports this module, so going through
// it here would close an import cycle.
import { sliceAtCodeUnitLimit } from './session-scanner-text-normalization'

// Why: safety only for pathological multi-MB pastes. Copy path must not use the
// 220-char list preview cap.
const FULL_FIRST_USER_PROMPT_SAFETY_LIMIT = 256 * 1024

// Codex uses input_text; most others use text. Never treat tool/image blocks as
// the written first ask.
const TEXT_LIKE_BLOCK_TYPES = new Set(['text', 'input_text', 'output_text'])

/** True only while an on-demand first-prompt read is re-parsing one transcript. */
export function shouldCaptureFullFirstUserPrompt(): boolean {
  return getFirstUserPromptCaptureMode() === 'full'
}

/**
 * Extract the written first-user ask for copy/reuse. Preserves newlines and does
 * not apply list-preview caps. Returns null for non-text / harness / empty.
 */
export function extractFullFirstUserPromptText(value: unknown): string | null {
  if (typeof value === 'string') {
    return finalizeFullFirstUserPrompt(value)
  }

  // Single content block object (not wrapped in an array).
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const blockText = firstUserPromptContentItemText(value)
    return blockText != null ? finalizeFullFirstUserPrompt(blockText) : null
  }

  if (!Array.isArray(value)) {
    return null
  }

  const parts: string[] = []
  for (const item of value) {
    const text = firstUserPromptContentItemText(item)
    if (text != null) {
      parts.push(text)
    }
  }
  if (parts.length === 0) {
    return null
  }
  return finalizeFullFirstUserPrompt(parts.join('\n'))
}

export function normalizeFullFirstUserPromptText(value: string): string | null {
  return finalizeFullFirstUserPrompt(value)
}

function finalizeFullFirstUserPrompt(value: string): string | null {
  // Why: Grok (and some pasted transcripts) wrap the real ask in <user_query>;
  // strip that before copy so the clipboard is the typed prompt, not user_info.
  const unwrapped = stripGrokUserQueryEnvelope(value.replace(/^\uFEFF/, ''))
  const trimmed = unwrapped.trim()
  if (!trimmed) {
    return null
  }
  if (isSuppressedFullFirstUserPrompt(trimmed)) {
    return null
  }
  if (isKnownHarnessInjectedUserTurnText(trimmed)) {
    return null
  }
  // Reject pure Grok bootstrap dumps even when they arrived via a non-Grok path.
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('<user_info>') && !lower.includes('<user_query>')) {
    return null
  }
  return sliceAtCodeUnitLimit(trimmed, FULL_FIRST_USER_PROMPT_SAFETY_LIMIT)
}

function isSuppressedFullFirstUserPrompt(value: string): boolean {
  const head = value.slice(0, 64).toLowerCase()
  return head.startsWith('# agents.md instructions') || head.startsWith('<instructions>')
}

function firstUserPromptContentItemText(item: unknown): string | null {
  if (typeof item === 'string') {
    return item
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return null
  }
  const record = item as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : null
  if (type != null && !TEXT_LIKE_BLOCK_TYPES.has(type)) {
    return null
  }
  if (typeof record.text === 'string' && record.text.length > 0) {
    return record.text
  }
  // Some providers put the body on `content` for text-shaped blocks.
  if (typeof record.content === 'string' && record.content.length > 0) {
    return record.content
  }
  return null
}
