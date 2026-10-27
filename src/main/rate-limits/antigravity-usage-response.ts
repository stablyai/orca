import type { RateLimitBucket, RateLimitWindow } from '../../shared/rate-limit-types'
import { deriveMostConstrainedWindow } from './rate-limit-bucket-summary'

/** Parse command.data from agy print envelopes (verified 1.2.11); response text rounds fractions and loses ids/disabled flags. */

// agy names windows; Orca maps them to minutes.
const WEEKLY_WINDOW_MINUTES = 10_080
const SESSION_WINDOW_MINUTES = 300

export type AntigravityUsageBucket = RateLimitBucket & {
  /** Stable agy id, such as gemini-weekly or 3p-5h. */
  id: string
}

export type AntigravityUsageReading = {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  buckets: AntigravityUsageBucket[]
  description: string | null
}

type RawBucket = {
  id?: unknown
  name?: unknown
  window?: unknown
  remaining_fraction?: unknown
  reset_time?: unknown
  disabled?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Unknown windows retain named buckets without being relabelled as weekly/session. */
function windowMinutesFor(window: string | null): number | null {
  if (window === 'weekly') {
    return WEEKLY_WINDOW_MINUTES
  }
  if (window === '5h') {
    return SESSION_WINDOW_MINUTES
  }
  return null
}

function parseResetsAt(value: unknown): number | null {
  const text = readString(value)
  if (!text) {
    return null
  }
  const parsed = new Date(text).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

/** Group names distinguish identical quota labels; append bucket names only for multiple windows. */
function formatBucketName(groupName: string, bucketName: string | null, siblings: number): string {
  if (siblings <= 1 || !bucketName) {
    return groupName
  }
  return `${groupName} · ${bucketName}`
}

function parseBucket(
  raw: RawBucket,
  groupName: string,
  siblings: number
): AntigravityUsageBucket | null {
  const id = readString(raw.id)
  const fraction = raw.remaining_fraction
  if (!id || typeof fraction !== 'number' || !Number.isFinite(fraction)) {
    return null
  }
  // Disabled means unmetered; drawing it as unused could invent headroom beside an exhausted pool (#22511).
  if (raw.disabled === true) {
    return null
  }
  const usedPercent = Math.min(100, Math.max(0, Math.round((1 - fraction) * 100)))
  const windowName = readString(raw.name)
  return {
    id,
    name: formatBucketName(groupName, windowName, siblings),
    // Structured fields let renderers label without parsing display names.
    group: groupName,
    ...(windowName ? { windowName } : {}),
    usedPercent,
    // Preserve unknown-window quota as a named bucket; RateLimitWindow requires numeric duration.
    windowMinutes: windowMinutesFor(readString(raw.window)) ?? 0,
    resetsAt: parseResetsAt(raw.reset_time),
    resetDescription: null
  }
}

function parseGroups(groups: unknown[]): AntigravityUsageBucket[] {
  const parsed: AntigravityUsageBucket[] = []
  for (const group of groups) {
    if (!isRecord(group)) {
      continue
    }
    const groupName = readString(group.name)
    const buckets = Array.isArray(group.buckets) ? group.buckets : []
    if (!groupName) {
      continue
    }
    const enabled = buckets.filter(
      (bucket): bucket is RawBucket => isRecord(bucket) && bucket.disabled !== true
    )
    for (const bucket of enabled) {
      const result = parseBucket(bucket, groupName, enabled.length)
      if (result) {
        parsed.push(result)
      }
    }
  }
  return parsed
}

/** Null means no valid usage reply, distinct from a successful empty quota payload. */
export function parseAntigravityUsageEnvelope(value: unknown): AntigravityUsageReading | null {
  if (!isRecord(value)) {
    return null
  }
  if (readString(value.status) !== 'SUCCESS') {
    return null
  }
  const command = value.command
  if (!isRecord(command)) {
    return null
  }
  // /quota aliases /usage; both answer as usage, proving this is a quota reply.
  if (readString(command.name) !== 'usage') {
    return null
  }
  const data = command.data
  if (!isRecord(data) || !Array.isArray(data.groups)) {
    return null
  }
  const buckets = parseGroups(data.groups)
  if (data.groups.length > 0 && buckets.length === 0) {
    return null
  }
  const windowsOf = (minutes: number): AntigravityUsageBucket[] =>
    buckets.filter((bucket) => bucket.windowMinutes === minutes)
  return {
    session: deriveMostConstrainedWindow(windowsOf(SESSION_WINDOW_MINUTES)),
    weekly: deriveMostConstrainedWindow(windowsOf(WEEKLY_WINDOW_MINUTES)),
    buckets,
    description: readString(data.description)
  }
}

/** Allow CLI log noise around the JSON envelope. */
function findInStdoutEnvelopes<T>(stdout: string, read: (value: unknown) => T | null): T | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      continue
    }
    try {
      const found = read(JSON.parse(trimmed))
      if (found !== null) {
        return found
      }
    } catch {
      continue
    }
  }
  return null
}

export function parseAntigravityUsageStdout(stdout: string): AntigravityUsageReading | null {
  return findInStdoutEnvelopes(stdout, parseAntigravityUsageEnvelope)
}

/** agy's own error text from a `{"status":"ERROR","error":…}` print envelope. */
export function readAntigravityErrorEnvelope(stdout: string): string | null {
  return findInStdoutEnvelopes(stdout, (value) =>
    isRecord(value) && readString(value.status) === 'ERROR' ? readString(value.error) : null
  )
}

/** Unknown slash commands can become billed model prompts; conversation/turn evidence must stop future polling. */
export function didRunModelTurn(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  const turns = value.num_turns
  if (typeof turns === 'number' && turns > 0) {
    return true
  }
  return readString(value.conversation_id) !== null
}

export function stdoutShowsModelTurn(stdout: string): boolean {
  return findInStdoutEnvelopes(stdout, (value) => (didRunModelTurn(value) ? true : null)) !== null
}
