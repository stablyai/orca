import {
  classifyAgyOutputFailure,
  stderrShowsInteractiveSignIn,
  type AgyOutputFailure
} from '../../../antigravity/agy-signed-out-output'
import { stripTerminalControl } from '../../../../shared/terminal/protocol/escape/terminal-control-stripping'
import { redactString } from '../../../observability/redactor'

const AGY_MESSAGE_MAX_LENGTH = 160
// Start at a boundary to avoid quadratic retries inside long, unbroken diagnostics.
const EMAIL_PATTERN = /(^|[\s@])[^\s@]+@[^\s@]+\.[^\s@]+/g
const TOKEN_LIKE_PATTERN = /[\w-]{32,}/g

export type AntigravityUsageFailure = AgyOutputFailure

export { classifyAgyOutputFailure as classifyAntigravityUsageFailure, stderrShowsInteractiveSignIn }

/** One bounded line of agy's error text, safe to show in the status bar. */
export function formatAgyErrorForDisplay(text: string): string | null {
  const line = redactString(stripTerminalControl(text))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(EMAIL_PATTERN, '$1[email]')
    .replace(TOKEN_LIKE_PATTERN, '[redacted]')
  if (!line) {
    return null
  }
  const chars = Array.from(line)
  if (chars.length <= AGY_MESSAGE_MAX_LENGTH) {
    return line
  }
  const kept = chars.slice(0, AGY_MESSAGE_MAX_LENGTH - 1).join('')
  return `${kept.trimEnd()}…`
}
