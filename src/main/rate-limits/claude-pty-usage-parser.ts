import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { extractClaudePtyResetMetadata } from './claude-pty-reset-parser'

// Why: these patterns match the Claude CLI's /usage TUI panel output.
// "Current session" shows a percent like "62% used" or "62% left".
// Weekly labels have varied between "Current week" and "Weekly limits".
const SESSION_RE = /current\s*session/i
const WEEKLY_RE = /(?:current\s*week|weekly\s*(?:limits?|usage|rate\s*limits?)|7\s*[- ]?\s*day)/i
const FABLE_WORD_RE = /\bfable\b/i
const FABLE_LABEL_RE = /^\s*fable\s*$/i
// Why: derive from WEEKLY_RE so a future weekly-wording change stays in one place
// instead of silently reopening the Fable-weekly parsing gap this fix closed.
const FABLE_WEEKLY_LABEL_RE = new RegExp(
  `${WEEKLY_RE.source}\\s*(?:\\([^)]*\\bfable\\b[^)]*\\)|[-:]?\\s*\\bfable\\b)`,
  'i'
)
const PERCENT_RE = /(\d{1,3})(?:\.\d+)?\s*%\s*(used|consumed|left|remaining|available)/i
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const OSC_SEQUENCE_RE = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, 'g')
const CSI_SEQUENCE_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')

export function stripTerminalControlSequences(output: string): string {
  return output.replace(OSC_SEQUENCE_RE, '').replace(CSI_SEQUENCE_RE, '')
}

/**
 * Extract percent-left from lines following a label match.
 * Scans up to 12 lines after the label to find the associated percent.
 */
function matchesWeeklyLabel(line: string): boolean {
  return WEEKLY_RE.test(line) && !FABLE_WORD_RE.test(line)
}

function matchesFableBoundary(line: string): boolean {
  return FABLE_LABEL_RE.test(line) || (FABLE_WORD_RE.test(line) && WEEKLY_RE.test(line))
}

function matchesFableUsageLabel(line: string): boolean {
  // Why: broad Fable-weekly copy should stop nearby scans, but only a real
  // Fable usage heading should produce the distinct Fable meter.
  return FABLE_LABEL_RE.test(line) || FABLE_WEEKLY_LABEL_RE.test(line)
}

function isSectionLabel(line: string): boolean {
  return SESSION_RE.test(line) || matchesWeeklyLabel(line) || matchesFableBoundary(line)
}

function extractPercentAfterLabel(
  lines: string[],
  matchesLabel: (line: string) => boolean
): number | null {
  for (let i = 0; i < lines.length; i++) {
    if (!matchesLabel(lines[i])) {
      continue
    }
    // Scan next 12 lines for a percent
    for (let j = i; j < Math.min(i + 12, lines.length); j++) {
      if (j > i && isSectionLabel(lines[j])) {
        break
      }
      const m = PERCENT_RE.exec(lines[j])
      if (m) {
        const pct = Number.parseFloat(m[1])
        const word = m[2].toLowerCase()
        const isUsed = word === 'used' || word === 'consumed'
        return isUsed ? pct : 100 - pct
      }
    }
  }
  return null
}

export function parseClaudePtyUsage(output: string): {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  fableWeekly: RateLimitWindow | null
} {
  const lines = output.split(/\r\n|\n|\r/)

  const sessionPct = extractPercentAfterLabel(lines, (line) => SESSION_RE.test(line))
  const weeklyPct = extractPercentAfterLabel(lines, matchesWeeklyLabel)
  const fableWeeklyPct = extractPercentAfterLabel(lines, matchesFableUsageLabel)
  const sessionReset = extractClaudePtyResetMetadata(
    lines,
    (line) => SESSION_RE.test(line),
    isSectionLabel
  )
  const weeklyReset = extractClaudePtyResetMetadata(lines, matchesWeeklyLabel, isSectionLabel)
  const fableWeeklyReset = extractClaudePtyResetMetadata(
    lines,
    matchesFableUsageLabel,
    isSectionLabel
  )

  const session: RateLimitWindow | null =
    sessionPct !== null
      ? {
          usedPercent: Math.min(100, Math.max(0, sessionPct)),
          windowMinutes: 300,
          resetsAt: sessionReset.resetsAt,
          resetDescription: sessionReset.resetDescription
        }
      : null

  const weekly: RateLimitWindow | null =
    weeklyPct !== null
      ? {
          usedPercent: Math.min(100, Math.max(0, weeklyPct)),
          windowMinutes: 10080,
          resetsAt: weeklyReset.resetsAt,
          resetDescription: weeklyReset.resetDescription
        }
      : null

  const fableWeekly: RateLimitWindow | null =
    fableWeeklyPct !== null
      ? {
          usedPercent: Math.min(100, Math.max(0, fableWeeklyPct)),
          windowMinutes: 10080,
          resetsAt: fableWeeklyReset.resetsAt,
          resetDescription: fableWeeklyReset.resetDescription
        }
      : null

  return { session, weekly, fableWeekly }
}

const RATE_LIMITED_RE = /rate limited\.?\s+please try again later/i
const LOAD_FAILED_RE = /failed to load usage data/i
const CLAUDE_21_USAGE_TABS_RE = /settings?\s+status?\s+config\s+usage\s+stats/i
const CLAUDE_21_SESSION_STATS_RE = /total\s*cost|total\s*duration|usage:\s*\d+\s*input/i

export function isClaude21UsagePanel(output: string): boolean {
  return CLAUDE_21_USAGE_TABS_RE.test(output) || CLAUDE_21_SESSION_STATS_RE.test(output)
}

export function describeClaudeUsageFailure(output: string): string {
  if (RATE_LIMITED_RE.test(output)) {
    return 'Claude usage is rate limited right now.'
  }

  if (LOAD_FAILED_RE.test(output)) {
    return 'Claude usage is unavailable right now.'
  }

  if (CLAUDE_21_USAGE_TABS_RE.test(output) || CLAUDE_21_SESSION_STATS_RE.test(output)) {
    return 'Claude plan usage is unavailable for this Claude CLI session.'
  }

  // Why: parser failures are an implementation detail of Orca's PTY fallback.
  // The UI should explain the user-visible outcome, not leak internal parsing
  // mechanics that the user cannot act on.
  return 'Claude usage is unavailable right now.'
}

export function abortedClaudeUsageResult(): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'Rate-limit fetch aborted',
    status: 'error'
  }
}
