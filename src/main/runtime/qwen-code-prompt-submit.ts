const QWEN_CODE_PENDING_PASTE = /^\*\s+\[Pasted Content \d+ chars\]\s*$/

// Qwen Code's Windows key parser keeps paste state for up to 1 s after the last paste byte.
export const QWEN_CODE_SUBMIT_RETRY_DELAY_MS = 1_100

/** True only while Qwen's active composer still owns a collapsed large paste. */
export function hasPendingQwenCodePastedContent(lines: readonly string[]): boolean {
  return lines.some((line) => QWEN_CODE_PENDING_PASTE.test(line))
}
