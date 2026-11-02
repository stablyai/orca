import { isKnownHarnessInjectedUserTurnText } from '../../shared/harness-injected-user-turns'
import { getFirstUserPromptCaptureMode } from './session-scanner-first-user-prompt-capture'
import { stripGrokUserQueryEnvelope } from './session-scanner-grok-user-text'
// Import directly to avoid a cycle through the session-scanner-values re-export.
import { sliceAtCodeUnitLimit } from './session-scanner-text-normalization'

// Bound pathological pastes without applying the much smaller list-preview cap.
const FULL_FIRST_USER_PROMPT_SAFETY_LIMIT = 256 * 1024

// Ignore tool/image blocks; providers use several text-block spellings.
const TEXT_LIKE_BLOCK_TYPES = new Set(['text', 'input_text', 'output_text'])

export function shouldCaptureFullFirstUserPrompt(): boolean {
  return getFirstUserPromptCaptureMode() === 'full'
}

/** Preserve prompt newlines for copy/reuse; exclude empty, harness and non-text content. */
export function extractFullFirstUserPromptText(value: unknown): string | null {
  if (typeof value === 'string') {
    return finalizeFullFirstUserPrompt(value)
  }

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
  // Bound before scanning so a multi-MB paste cannot force a full lowercase copy.
  const bounded = sliceAtCodeUnitLimit(trimmed, FULL_FIRST_USER_PROMPT_SAFETY_LIMIT)
  // The full envelope was stripped before bounding, so this bootstrap check cannot hide a late user_query.
  const lower = bounded.toLowerCase()
  if (lower.startsWith('<user_info>') && !lower.includes('<user_query>')) {
    return null
  }
  return bounded
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
