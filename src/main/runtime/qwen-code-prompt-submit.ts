const QWEN_CODE_PENDING_PASTE = /^\*\s+\[Pasted Content \d+ chars\]\s*$/
const QWEN_CODE_COMPOSER_PROMPT = 'Type your message or @path/to/file'

// Qwen Code's Windows key parser keeps paste state for up to 1 s after the last paste byte.
export const QWEN_CODE_SUBMIT_RETRY_DELAY_MS = 1_100
export const QWEN_CODE_COMPOSER_READY_POLL_MS = 50

/** True only while Qwen's active composer still owns a collapsed large paste. */
export function hasPendingQwenCodePastedContent(lines: readonly string[]): boolean {
  return lines.some((line) => QWEN_CODE_PENDING_PASTE.test(line))
}

/** True while Qwen still exposes non-empty text in its active composer draft. */
export function hasPendingQwenCodeComposerDraft(
  visible: { draft?: string } | null | undefined
): boolean {
  return typeof visible?.draft === 'string' && visible.draft.trim().length > 0
}

/** True only when Qwen's visible input composer is mounted. */
export function hasReadyQwenCodeComposer(lines: readonly string[]): boolean {
  return lines.some((line) => line.includes(QWEN_CODE_COMPOSER_PROMPT))
}
