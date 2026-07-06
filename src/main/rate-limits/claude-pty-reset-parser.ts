import type { RateLimitWindow } from '../../shared/rate-limit-types'
import { buildWallClockTimestamp } from './time-zone-wall-clock'

const RESET_LINE_RE = /resets?\s+(?:at\s+|in\s+)?(.+)/i
const MONTH_PATTERN =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
const MONTH_DAY_COMPACT_RE = new RegExp(
  `\\b(${MONTH_PATTERN})(\\d{1,2})(?=\\s*at\\s*\\d|\\D|$)`,
  'i'
)
const MONTH_DAY_TIME_RE = new RegExp(
  `\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:,?\\s*(?:at\\s+)?)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)\\b`,
  'i'
)
const WEEKDAY_TIME_RE =
  /\b(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\.?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i
const TIME_ONLY_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i
const RELATIVE_RESET_RE = /^(?:\s*\d+\s*(?:d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?)\s*)+$/i
const RELATIVE_RESET_TOKEN_RE = /(\d+)\s*(d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?)/gi
const IANA_TIME_ZONE_RE = /\(([^()]*)\)?\s*$/

export type ClaudePtyResetMetadata = Pick<RateLimitWindow, 'resetsAt' | 'resetDescription'>

const MONTH_INDEX_BY_NAME: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11
}

const WEEKDAY_INDEX_BY_NAME: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6
}

export function extractClaudePtyResetMetadata(
  lines: string[],
  matchesLabel: (line: string) => boolean,
  isSectionLabel: (line: string) => boolean
): ClaudePtyResetMetadata {
  for (let i = 0; i < lines.length; i++) {
    if (!matchesLabel(lines[i])) {
      continue
    }
    for (let j = i; j < Math.min(i + 14, lines.length); j++) {
      if (j > i && isSectionLabel(lines[j])) {
        break
      }
      const m = RESET_LINE_RE.exec(lines[j])
      if (m) {
        const resetDescription = normalizeResetDescription(m[1])
        return {
          resetsAt: parseResetTimestamp(resetDescription),
          resetDescription
        }
      }
    }
  }
  return { resetsAt: null, resetDescription: null }
}

function normalizeResetDescription(raw: string): string {
  // Why: Claude's TUI occasionally drops spaces around the Fable reset date
  // when copied from the PTY buffer, but the value still encodes a real reset.
  return raw
    .trim()
    .replace(/[)]+$/, '')
    .replace(/\s+/g, ' ')
    .replace(MONTH_DAY_COMPACT_RE, '$1 $2')
    .replace(/(\d{1,2})\s*at\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i, '$1 at $2')
    .replace(/(\d)(am|pm)\(/gi, '$1$2 (')
}

function parseResetTimestamp(resetDescription: string | null): number | null {
  if (!resetDescription) {
    return null
  }

  return (
    parseRelativeResetTimestamp(resetDescription) ??
    parseMonthDayResetTimestamp(resetDescription) ??
    parseWeekdayResetTimestamp(resetDescription) ??
    parseTimeOnlyResetTimestamp(resetDescription)
  )
}

function parseRelativeResetTimestamp(resetDescription: string): number | null {
  if (!RELATIVE_RESET_RE.test(resetDescription)) {
    return null
  }

  let durationMs = 0
  for (const match of resetDescription.matchAll(RELATIVE_RESET_TOKEN_RE)) {
    const amount = Number(match[1])
    const unit = match[2].toLowerCase()[0]
    if (!Number.isFinite(amount)) {
      continue
    }
    if (unit === 'd') {
      durationMs += amount * 24 * 60 * 60_000
    } else if (unit === 'h') {
      durationMs += amount * 60 * 60_000
    } else if (unit === 'm') {
      durationMs += amount * 60_000
    }
  }
  return durationMs > 0 ? Date.now() + durationMs : null
}

function parseMonthDayResetTimestamp(resetDescription: string): number | null {
  const resetText = stripResetTimeZone(resetDescription)
  const match = MONTH_DAY_TIME_RE.exec(resetText)
  if (!match) {
    return null
  }

  const monthIndex = MONTH_INDEX_BY_NAME[match[1].toLowerCase()]
  if (monthIndex === undefined) {
    return null
  }

  const day = Number(match[2])
  const hour = parseHour(match[3], match[5])
  const minute = Number(match[4] ?? 0)
  if (!isValidClockTime(hour, minute)) {
    return null
  }

  const now = new Date()
  const timeZone = extractResetTimeZone(resetDescription)
  let timestamp = buildWallClockTimestamp(
    { year: now.getFullYear(), monthIndex, day, hour, minute },
    timeZone
  )
  if (timestamp !== null && timestamp <= Date.now()) {
    timestamp = buildWallClockTimestamp(
      { year: now.getFullYear() + 1, monthIndex, day, hour, minute },
      timeZone
    )
  }
  return timestamp
}

function parseWeekdayResetTimestamp(resetDescription: string): number | null {
  const resetText = stripResetTimeZone(resetDescription)
  const match = WEEKDAY_TIME_RE.exec(resetText)
  if (!match) {
    return null
  }

  const weekdayIndex = WEEKDAY_INDEX_BY_NAME[match[1].toLowerCase()]
  if (weekdayIndex === undefined) {
    return null
  }

  const now = new Date()
  const hour = parseHour(match[2], match[4])
  const minute = Number(match[3] ?? 0)
  if (!isValidClockTime(hour, minute)) {
    return null
  }

  const candidate = new Date(now)
  const daysUntil = (weekdayIndex - now.getDay() + 7) % 7
  candidate.setDate(now.getDate() + daysUntil)
  candidate.setHours(hour, minute, 0, 0)
  if (candidate.getTime() <= Date.now()) {
    candidate.setDate(candidate.getDate() + 7)
  }
  return candidate.getTime()
}

function parseTimeOnlyResetTimestamp(resetDescription: string): number | null {
  const resetText = stripResetTimeZone(resetDescription)
  const match = TIME_ONLY_RE.exec(resetText)
  if (!match) {
    return null
  }

  const hour = parseHour(match[1], match[3])
  const minute = Number(match[2] ?? 0)
  if (!isValidClockTime(hour, minute)) {
    return null
  }

  const candidate = new Date()
  candidate.setHours(hour, minute, 0, 0)
  if (candidate.getTime() <= Date.now()) {
    candidate.setDate(candidate.getDate() + 1)
  }
  return candidate.getTime()
}

function parseHour(hourText: string, periodText: string): number {
  const hour = Number(hourText)
  const period = periodText.toLowerCase()
  if (hour < 1 || hour > 12) {
    return Number.NaN
  }
  if (period === 'am') {
    return hour === 12 ? 0 : hour
  }
  return hour === 12 ? 12 : hour + 12
}

function isValidClockTime(hour: number, minute: number): boolean {
  return Number.isInteger(hour) && hour >= 0 && hour < 24 && minute >= 0 && minute < 60
}

function stripResetTimeZone(resetDescription: string): string {
  return resetDescription.replace(/\s*\([^)]*\)?\s*$/, '').trim()
}

function extractResetTimeZone(resetDescription: string): string | null {
  const match = IANA_TIME_ZONE_RE.exec(resetDescription)
  if (!match?.[1]) {
    return null
  }
  const timeZone = match[1].trim()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return timeZone
  } catch {
    return null
  }
}
