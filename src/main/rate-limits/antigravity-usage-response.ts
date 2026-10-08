import type { RateLimitBucket, RateLimitWindow } from '../../shared/rate-limit-types'
import { deriveMostConstrainedWindow } from './rate-limit-bucket-summary'

/**
 * Parses what `agy -p "/usage" --output-format json` prints.
 *
 * The shape is agy's print-mode envelope with the slash command's own payload attached, verified
 * against agy 1.2.11 on macOS:
 *
 * ```json
 * { "status": "SUCCESS", "response": "Gemini Models\tWeekly Limit Remaining\t100%\t2026-10-07T08:08:35Z\n…",
 *   "command": { "name": "usage", "data": { "description": "…", "groups": [
 *     { "name": "Gemini Models", "description": "Models within this group: Gemini Flash, Gemini Pro",
 *       "buckets": [{ "id": "gemini-weekly", "name": "Weekly Limit Remaining", "window": "weekly",
 *                     "remaining_fraction": 1, "reset_time": "2026-10-07T08:08:35Z" }] } ] } } }
 * ```
 *
 * `command.data` is the contract, not the `response` text: the text is a lossy tab-joined rendering
 * that rounds the fraction to a whole percent and drops both the bucket ids and `disabled`.
 */

/** 7 days. agy reports the window by name, so the minute count is Orca's mapping, not agy's. */
const WEEKLY_WINDOW_MINUTES = 10_080
/** 5 hours. Only some tiers expose a 5h bucket; a tier without one reports weekly alone. */
const SESSION_WINDOW_MINUTES = 300

export type AntigravityUsageBucket = RateLimitBucket & {
  /** agy's stable bucket id (`gemini-weekly`, `gemini-5h`, `3p-weekly`, `3p-5h`). */
  id: string
}

export type AntigravityUsageReading = {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  buckets: AntigravityUsageBucket[]
  /** agy's own explanation of how the pools work, shown as the segment's help text. */
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

/**
 * Maps agy's window name onto Orca's minute count.
 *
 * Why only these two: agy groups models into pools that share a limit, and a pool carries at most a
 * rolling 5h bucket and a weekly bucket. An unrecognised name is reported as a named bucket with no
 * window rather than being forced into one of the two, so a new agy window cannot silently be drawn
 * as a weekly limit.
 */
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

/**
 * Why a group name and not the bucket name: every bucket in the payload is called "Weekly Limit
 * Remaining", so the bucket name alone renders two identical rows. The group is what distinguishes
 * them ("Gemini Models" vs "Claude and GPT models"), and the agy label is only appended when one
 * group reports more than one window.
 */
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
  // Why skip: a disabled bucket is one the tier does not meter at all. #22511 saw `gemini-5h`
  // disabled while `gemini-weekly` was exhausted; drawing the disabled bucket as 0% used would
  // report headroom the account does not have.
  if (raw.disabled === true) {
    return null
  }
  const usedPercent = Math.min(100, Math.max(0, Math.round((1 - fraction) * 100)))
  return {
    id,
    name: formatBucketName(groupName, readString(raw.name), siblings),
    usedPercent,
    // Why 0 and not null: RateLimitWindow requires a number, and an unrecognised agy window still
    // carries a real remaining fraction worth showing as a named bucket.
    windowMinutes: windowMinutesFor(readString(raw.window)) ?? 0,
    resetsAt: parseResetsAt(raw.reset_time),
    resetDescription: null
  }
}

function parseGroups(groups: unknown): AntigravityUsageBucket[] {
  if (!Array.isArray(groups)) {
    return []
  }
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

/**
 * Reads the usage payload out of an agy print-mode envelope.
 *
 * Returns null when the envelope is not a successful usage reply, which the caller reports as an
 * unreadable quota rather than as an empty one — "no buckets" and "agy did not answer" are
 * different states and only the first is safe to draw as 0% used.
 */
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
  // Why check the command name: `/usage` and `/quota` are aliases that both answer as `usage`, so
  // the name is what proves the payload is a quota reply and not some other command's data.
  if (readString(command.name) !== 'usage') {
    return null
  }
  const data = command.data
  if (!isRecord(data)) {
    return null
  }
  const buckets = parseGroups(data.groups)
  if (buckets.length === 0) {
    return null
  }
  // Why drop the id first: the summary is a RateLimitWindow, and the summariser only strips `name`,
  // so an id left on the bucket would ride into the published window.
  const windowsOf = (minutes: number): RateLimitBucket[] =>
    buckets
      .filter((bucket) => bucket.windowMinutes === minutes)
      .map(({ id: _id, ...bucket }) => bucket)
  return {
    session: deriveMostConstrainedWindow(windowsOf(SESSION_WINDOW_MINUTES)),
    weekly: deriveMostConstrainedWindow(windowsOf(WEEKLY_WINDOW_MINUTES)),
    buckets,
    description: readString(data.description)
  }
}

/** Finds the usage envelope in agy's stdout, which may carry log noise around the JSON line. */
export function parseAntigravityUsageStdout(stdout: string): AntigravityUsageReading | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      continue
    }
    try {
      const reading = parseAntigravityUsageEnvelope(JSON.parse(trimmed))
      if (reading) {
        return reading
      }
    } catch {
      continue
    }
  }
  return null
}

/**
 * True when the envelope shows agy ran a model turn instead of answering a command.
 *
 * Why this matters: in print mode an *unrecognised* slash command is not an error — agy sends the
 * text to the model as an ordinary prompt. On a build of agy that does not know `/usage`, polling
 * would quietly start a conversation and spend the user's quota every cycle while Orca reported
 * "did not report a quota". A real command reply carries an empty `conversation_id` and
 * `num_turns: 0`; a prompt carries a conversation id and at least one turn.
 */
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

/** Scans agy stdout for evidence that the quota read was answered by the model, not by a command. */
export function stdoutShowsModelTurn(stdout: string): boolean {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      continue
    }
    try {
      if (didRunModelTurn(JSON.parse(trimmed))) {
        return true
      }
    } catch {
      continue
    }
  }
  return false
}
