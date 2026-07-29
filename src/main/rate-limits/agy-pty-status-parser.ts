import type { RateLimitWindow } from '../../shared/rate-limit-types'
import { extractClaudePtyResetMetadata } from './claude-pty-reset-parser'

export const FIVE_HOUR_RE =
  /(?<![\w-][^\S\r\n]{0,4})five\s+hour\s+limit[\s\S]*?(\d+(?:\.\d+)?)%(?:\s*(?:(?:\d+(?:\.\d+)?)%?\s*)?(used|left|remaining))?/i
export const WEEKLY_RE =
  /(?<![\w-][^\S\r\n]{0,4})weekly\s+limit[\s\S]*?(\d+(?:\.\d+)?)%(?:\s*(?:(?:\d+(?:\.\d+)?)%?\s*)?(used|left|remaining))?/i

const ANY_LIMIT_LABEL_RE = /(?:five\s+hour|weekly)\s+limit/i
const FIVE_HOUR_LABEL_RE = /five\s+hour\s+limit/i
const WEEKLY_LABEL_RE = /weekly\s+limit/i
// eslint-disable-next-line no-control-regex
const PTY_CONTROL_SEQUENCE_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g

export function stripPtyControlSequences(output: string): string {
  return output.replace(PTY_CONTROL_SEQUENCE_RE, '')
}

export function isPtyLimitLabel(line: string): boolean {
  return ANY_LIMIT_LABEL_RE.test(line)
}
function isFiveHourLimitLabel(line: string): boolean {
  return FIVE_HOUR_LABEL_RE.test(line)
}
function isWeeklyLimitLabel(line: string): boolean {
  return WEEKLY_LABEL_RE.test(line)
}

function ptyUsedPercent(match: RegExpExecArray): number {
  const rawPct = Number.parseFloat(match[1])
  const oriented = ['left', 'remaining'].includes(match[2]?.toLowerCase() ?? '')
    ? 100 - rawPct
    : rawPct
  return Math.min(100, Math.max(0, oriented))
}

export function parsePtyStatus(output: string): {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
} {
  const fiveMatch = FIVE_HOUR_RE.exec(output)
  const weeklyMatch = WEEKLY_RE.exec(output)
  const lines = output.split(/\r\n|\n|\r/)
  const sessionReset = extractClaudePtyResetMetadata(lines, isFiveHourLimitLabel, isPtyLimitLabel)
  const weeklyReset = extractClaudePtyResetMetadata(lines, isWeeklyLimitLabel, isPtyLimitLabel)

  const session: RateLimitWindow | null = fiveMatch
    ? {
        usedPercent: ptyUsedPercent(fiveMatch),
        windowMinutes: 300,
        resetsAt: sessionReset.resetsAt,
        resetDescription: sessionReset.resetDescription
      }
    : null

  const weekly: RateLimitWindow | null = weeklyMatch
    ? {
        usedPercent: ptyUsedPercent(weeklyMatch),
        windowMinutes: 10080,
        resetsAt: weeklyReset.resetsAt,
        resetDescription: weeklyReset.resetDescription
      }
    : null

  return { session, weekly }
}
