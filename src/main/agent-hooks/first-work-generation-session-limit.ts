import { stripAnsiControlSequences } from '../../shared/commit-message-agent-output'
import { extractClaudePtyResetMetadata } from '../rate-limits/claude-pty-reset-parser'
import type { GenerateBranchNameResult } from '../text-generation/commit-message-text-generation'

const SESSION_LIMIT_RE =
  /\b(?:(?:you(?:'ve| have)\s+)?hit\s+(?:your\s+)?session\s+limit|session\s+limit\s+(?:has\s+been\s+)?(?:reached|exceeded))\b/i
const UNPARSED_SESSION_LIMIT_COOLDOWN_MS = 15 * 60_000

type BranchNameGenerationFailure = Extract<GenerateBranchNameResult, { success: false }>

export function getFirstWorkGenerationSessionLimitRetryAt(
  failure: Pick<BranchNameGenerationFailure, 'error' | 'failureOutput'>
): number | null {
  const output = stripAnsiControlSequences(
    [failure.error, failure.failureOutput?.stderr, failure.failureOutput?.stdout]
      .filter((value): value is string => Boolean(value))
      .join('\n')
  )
  const lines = output.split(/\r?\n/)
  if (!lines.some((line) => SESSION_LIMIT_RE.test(line))) {
    return null
  }

  const reset = extractClaudePtyResetMetadata(
    lines,
    (line) => SESSION_LIMIT_RE.test(line),
    () => false
  )
  const now = Date.now()
  if (reset.resetsAt !== null && reset.resetsAt > now) {
    return reset.resetsAt
  }
  // 无法解析供应商文案时仍需限流，避免每个 working 事件都启动新会话。
  return now + UNPARSED_SESSION_LIMIT_COOLDOWN_MS
}
