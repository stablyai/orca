import type { RateLimitWindow } from '../../shared/rate-limit-types'
import { extractClaudePtyResetMetadata } from './claude-pty-reset-parser'

// Why: reject model-scoped rows regardless of row order in cursor-positioned output.
const FIVE_HOUR_RE = /(?<![\w-][^\S\r\n]{0,4})5h\s+limit[^\d%\r\n]*(\d+)%(?:\s*(used|left))?/i
const WEEKLY_RE = /(?<![\w-][^\S\r\n]{0,4})weekly\s+limit[^\d%\r\n]*(\d+)%(?:\s*(used|left))?/i
const ANY_LIMIT_LABEL_RE = /(?:5h|weekly)\s+limit/i
// eslint-disable-next-line no-control-regex
const PTY_CONTROL_SEQUENCE_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g

export function stripCodexPtyControlSequences(output: string): string {
  return output.replace(PTY_CONTROL_SEQUENCE_RE, '')
}

export function hasCodexPtyRateLimit(output: string): boolean {
  return FIVE_HOUR_RE.test(output) || WEEKLY_RE.test(output)
}

function ptyUsedPercent(match: RegExpExecArray): number {
  const pct = Number.parseInt(match[1], 10)
  const oriented = match[2]?.toLowerCase() === 'left' ? 100 - pct : pct
  return Math.min(100, Math.max(0, oriented))
}

export function parseCodexPtyStatus(output: string): {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
} {
  const fiveMatch = FIVE_HOUR_RE.exec(output)
  const weeklyMatch = WEEKLY_RE.exec(output)
  const lines = output.split(/\r\n|\n|\r/)
  const isLimitLabel = (line: string): boolean => ANY_LIMIT_LABEL_RE.test(line)
  const sessionReset = extractClaudePtyResetMetadata(
    lines,
    (line) => FIVE_HOUR_RE.test(line),
    isLimitLabel
  )
  const weeklyReset = extractClaudePtyResetMetadata(
    lines,
    (line) => WEEKLY_RE.test(line),
    isLimitLabel
  )

  return {
    session: fiveMatch
      ? {
          usedPercent: ptyUsedPercent(fiveMatch),
          windowMinutes: 300,
          resetsAt: sessionReset.resetsAt,
          resetDescription: sessionReset.resetDescription
        }
      : null,
    weekly: weeklyMatch
      ? {
          usedPercent: ptyUsedPercent(weeklyMatch),
          windowMinutes: 10080,
          resetsAt: weeklyReset.resetsAt,
          resetDescription: weeklyReset.resetDescription
        }
      : null
  }
}
