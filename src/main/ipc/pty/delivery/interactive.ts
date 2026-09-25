import { interactiveOutputCharsByPty, lastInputAtByPty } from './visibility-state'
import {
  INTERACTIVE_OUTPUT_BUDGET_CHARS,
  INTERACTIVE_OUTPUT_MAX_CHARS,
  INTERACTIVE_OUTPUT_WINDOW_MS,
  INTERACTIVE_REDRAW_MAX_CHARS
} from './constants'

export function isLikelyInteractiveRedraw(data: string): boolean {
  if (data.length <= INTERACTIVE_OUTPUT_MAX_CHARS) {
    return true
  }
  // Why the ANSI check: Codex-style TUIs repaint >1 KB per keypress (latency-sensitive), while plain command output should stay on the throughput batch path.
  return data.length <= INTERACTIVE_REDRAW_MAX_CHARS && data.includes('\x1b[')
}

export function shouldSendInteractiveOutputNow(id: string, data: string, now: number): boolean {
  const lastInputAt = lastInputAtByPty.get(id)
  if (lastInputAt === undefined || now - lastInputAt > INTERACTIVE_OUTPUT_WINDOW_MS) {
    interactiveOutputCharsByPty.delete(id)
    return false
  }
  if (!isLikelyInteractiveRedraw(data)) {
    interactiveOutputCharsByPty.set(id, INTERACTIVE_OUTPUT_BUDGET_CHARS)
    return false
  }
  const usedChars = interactiveOutputCharsByPty.get(id) ?? 0
  if (usedChars + data.length > INTERACTIVE_OUTPUT_BUDGET_CHARS) {
    interactiveOutputCharsByPty.set(id, INTERACTIVE_OUTPUT_BUDGET_CHARS)
    return false
  }
  interactiveOutputCharsByPty.set(id, usedChars + data.length)
  return true
}
