import type { YouTrackFieldKind, YouTrackFieldSchema } from '../../shared/youtrack-types'

export type WorkTime = { minutesADay: number; daysAWeek: number }
export const DEFAULT_WORK_TIME: WorkTime = { minutesADay: 480, daysAWeek: 5 }

const OPTION_TYPE_STEM: Partial<Record<YouTrackFieldKind, string>> = {
  enum: 'Enum',
  user: 'User',
  version: 'Version',
  build: 'Build',
  owned: 'Owned'
}

// Units as YouTrack prints them in English and Russian locales.
const PERIOD_UNIT_RE = /(\d+(?:[.,]\d+)?)\s*(w|н|d|д|h|ч|m|м)/gi

/** Parses "1w 2d 3h 30m" (or "2д 4ч"); a bare number means minutes. */
export function parsePeriodMinutes(input: string, workTime: WorkTime): number | null {
  const trimmed = input.trim().toLowerCase()
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed)
  }
  let minutes = 0
  let consumed = ''
  for (const match of trimmed.matchAll(PERIOD_UNIT_RE)) {
    const amount = Number(match[1].replace(',', '.'))
    const unit = match[2]
    const factor =
      unit === 'w' || unit === 'н'
        ? workTime.minutesADay * workTime.daysAWeek
        : unit === 'd' || unit === 'д'
          ? workTime.minutesADay
          : unit === 'h' || unit === 'ч'
            ? 60
            : 1
    minutes += amount * factor
    consumed += match[0]
  }
  // Reject input with leftovers like "2 days" so typos don't silently become 0.
  return consumed.replace(/\s/g, '') === trimmed.replace(/\s/g, '') && consumed
    ? Math.round(minutes)
    : null
}

type PayloadResult = { ok: true; payload: Record<string, unknown> } | { ok: false; error: string }

function scalarValue(
  schema: YouTrackFieldSchema,
  raw: string,
  workTime: WorkTime
): { ok: true; value: unknown } | { ok: false; error: string } {
  const invalid = { ok: false as const, error: `"${raw}" is not a valid ${schema.name}.` }
  switch (schema.kind) {
    case 'string':
      return { ok: true, value: raw }
    case 'text':
      return { ok: true, value: { $type: 'TextFieldValue', text: raw } }
    case 'integer':
      return /^-?\d+$/.test(raw.trim()) ? { ok: true, value: Number(raw) } : invalid
    case 'float': {
      const value = Number(raw.trim().replace(',', '.'))
      return Number.isFinite(value) ? { ok: true, value } : invalid
    }
    case 'date': {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim())
      // Noon UTC keeps the calendar day stable across time zones.
      return match
        ? {
            ok: true,
            value: Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)
          }
        : invalid
    }
    case 'datetime': {
      const value = new Date(raw).getTime()
      return Number.isFinite(value) ? { ok: true, value } : invalid
    }
    case 'period': {
      const minutes = parsePeriodMinutes(raw, workTime)
      return minutes === null
        ? { ok: false, error: `Use a period like "2d 4h" or "30m" for ${schema.name}.` }
        : { ok: true, value: { $type: 'PeriodValue', minutes } }
    }
    case 'enum':
    case 'user':
    case 'version':
    case 'build':
    case 'owned':
    case 'state':
    case 'unknown':
      return { ok: false, error: `${schema.name} can't be edited from Orca yet.` }
  }
}

const SCALAR_ISSUE_TYPE: Partial<Record<YouTrackFieldKind, string>> = {
  string: 'SimpleIssueCustomField',
  integer: 'SimpleIssueCustomField',
  float: 'SimpleIssueCustomField',
  date: 'DateIssueCustomField',
  // Why: YouTrack maps "date and time" fields to SimpleIssueCustomField, unlike date-only ones.
  datetime: 'SimpleIssueCustomField',
  period: 'PeriodIssueCustomField',
  text: 'TextIssueCustomField'
}

/** Builds the `customFields[]` entry YouTrack expects; empty `values` clears the field. */
export function buildFieldPayload(
  schema: YouTrackFieldSchema,
  values: string[],
  workTime: WorkTime = DEFAULT_WORK_TIME
): PayloadResult {
  // Why: a raw state write skips workflow transitions; state changes go through setState.
  if (schema.kind === 'state') {
    return {
      ok: false,
      error: `${schema.name} follows the project workflow; change it as a state transition.`
    }
  }
  const picked = values.map((value) => value.trim()).filter(Boolean)
  const stem = OPTION_TYPE_STEM[schema.kind]
  if (stem) {
    const known = new Set(schema.options.map((option) => option.value))
    const unknown = picked.find((value) => !known.has(value))
    if (unknown) {
      return { ok: false, error: `"${unknown}" is not an allowed value for ${schema.name}.` }
    }
    const key = schema.kind === 'user' ? 'login' : 'name'
    const toValue = (value: string): Record<string, string> => ({ [key]: value })
    return {
      ok: true,
      payload: schema.multi
        ? { name: schema.name, $type: `Multi${stem}IssueCustomField`, value: picked.map(toValue) }
        : {
            name: schema.name,
            $type: `Single${stem}IssueCustomField`,
            value: picked[0] ? toValue(picked[0]) : null
          }
    }
  }
  const issueType = SCALAR_ISSUE_TYPE[schema.kind]
  if (!issueType) {
    return { ok: false, error: `${schema.name} can't be edited from Orca yet.` }
  }
  if (picked.length === 0) {
    return { ok: true, payload: { name: schema.name, $type: issueType, value: null } }
  }
  const scalar = scalarValue(schema, values[0], workTime)
  return scalar.ok
    ? { ok: true, payload: { name: schema.name, $type: issueType, value: scalar.value } }
    : scalar
}
