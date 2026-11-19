import {
  usageLimitResetsAt,
  type AgentSessionUsageLimit
} from '../../../../shared/agent-session/failures/agent-session-usage-limit'

// The CLI's own limit line when it sends no typed api_error: older builds' "Claude AI usage limit
// reached|<epoch s>", and "You've hit your session limit · resets 3pm (America/New_York)", whose
// reset is "3pm" or "3:30pm" within a day, else "Nov 20, 3pm" (a year when not this one).
const LEGACY_LIMIT = /^Claude AI usage limit reached\|(\d{9,11})\s*$/i
const HIT_LIMIT = /^You(?:'|\u2019)ve hit your (?:[\w-]+ )*limit\b/i
const RESET =
  /\bresets (?:([A-Z][a-z]{2}) (\d{1,2}), (?:(\d{4}), )?)?(\d{1,2})(?::(\d{2}))? ?(am|pm)\b(?: \(([^)]+)\))?/i
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY_MS = 24 * 60 * 60 * 1000

/** Only for text the CLI sent as a rate-limit error or failed result, never for prose. */
export function claudeLimitLine(text: string, now: number): AgentSessionUsageLimit | null {
  const trimmed = text.trim()
  const legacy = LEGACY_LIMIT.exec(trimmed)?.[1]
  if (legacy) {
    const resetsAt = usageLimitResetsAt(Number(legacy) * 1000, now)
    return resetsAt ? { resetsAt } : {}
  }
  const hit = HIT_LIMIT.exec(trimmed)?.[0].toLowerCase()
  if (!hit) {
    return null
  }
  const window = / session /.test(hit) ? 'session' : / weekly /.test(hit) ? 'weekly' : undefined
  const resetsAt = usageLimitResetsAt(claudeResetAt(trimmed, now), now)
  return { ...(window ? { window } : {}), ...(resetsAt ? { resetsAt } : {}) }
}

/** The line's reset as epoch ms, read in the zone it names, else this machine's (the CLI's own). */
function claudeResetAt(text: string, now: number): number | undefined {
  const match = RESET.exec(text)
  if (!match) {
    return undefined
  }
  const [, monthName, dayText, yearText, hourText, minuteText, meridiem, zone] = match
  const hour = (Number(hourText) % 12) + (meridiem?.toLowerCase() === 'pm' ? 12 : 0)
  const minute = minuteText ? Number(minuteText) : 0
  if (hour > 23 || minute > 59) {
    return undefined
  }
  const today = zonedDate(now, zone)
  if (!today) {
    return undefined
  }
  if (!monthName) {
    // Time alone: its next occurrence, within the day the CLI shows it for.
    const at = zonedEpoch({ ...today, hour, minute }, zone)
    return at === undefined
      ? undefined
      : at > now
        ? at
        : zonedEpoch(nextDay(today, hour, minute), zone)
  }
  const month = MONTHS.indexOf(monthName.toLowerCase())
  if (month === -1) {
    return undefined
  }
  const year = yearText ? Number(yearText) : today.year
  return zonedEpoch({ year, month, day: Number(dayText), hour, minute }, zone)
}

type WallClock = { year: number; month: number; day: number; hour: number; minute: number }

function nextDay(date: WallClock, hour: number, minute: number): WallClock {
  const next = new Date(Date.UTC(date.year, date.month, date.day) + DAY_MS)
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth(),
    day: next.getUTCDate(),
    hour,
    minute
  }
}

/** The wall clock in `zone` (undefined: this machine's) at `epoch`; undefined for an unknown zone. */
function zonedDate(epoch: number, zone: string | undefined): WallClock | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric'
    }).formatToParts(epoch)
    const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value)
    return {
      year: part('year'),
      month: part('month') - 1,
      day: part('day'),
      hour: part('hour'),
      minute: part('minute')
    }
  } catch {
    return undefined
  }
}

/** The epoch whose wall clock in `zone` is `clock`, corrected once for the zone's offset there. */
function zonedEpoch(clock: WallClock, zone: string | undefined): number | undefined {
  const target = Date.UTC(clock.year, clock.month, clock.day, clock.hour, clock.minute)
  let epoch = target
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = zonedDate(epoch, zone)
    if (!seen) {
      return undefined
    }
    epoch += target - Date.UTC(seen.year, seen.month, seen.day, seen.hour, seen.minute)
  }
  return epoch
}
