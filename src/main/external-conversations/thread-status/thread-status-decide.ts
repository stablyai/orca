// What a bot thread's status lines do next, from its fact, its workers' latest read and the clock:
// nothing, stop quietly, or post one line. Pure, so every row is pinned by a test.
import type { ThreadStatusFact } from '../../../shared/connectors/external-conversation-link'
import type { ConversationWorkerView } from '../external-conversation-workers'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** Quiet time before each line, backing off: the first after 30 minutes, then 60, then every 120. */
export const THREAD_STATUS_DUE_MS = [30 * MINUTE_MS, 60 * MINUTE_MS, 120 * MINUTE_MS] as const
/** Lines stop this long after the pane's latest heard turn end. */
export const THREAD_STATUS_MAX_MS = 6 * HOUR_MS
/** Lines one thread may get in a UTC day. */
export const THREAD_STATUS_DAY_CAP = 12

export const THREAD_STATUS_WORKING_LINE = (elapsed: string): string =>
  `Still working on this (${elapsed}).`
export const THREAD_STATUS_IDLE_LINE = (elapsed: string): string =>
  `Still open (${elapsed}), but nothing is running on it right now. Reply here to ask where it stands.`
export const THREAD_STATUS_STOP_LINE =
  "No change for a while, so I'm stopping these automatic updates. Reply here to ask where it stands."

export type ThreadStatusView = Pick<ConversationWorkerView, 'activity' | 'open' | 'helpersRunning'>

export type ThreadStatusInput = {
  now: number
  /** A Slack bot thread or DM that isn't muted, blocked or its bot's refused. */
  eligible: boolean
  fact: ThreadStatusFact | undefined
  /** Undefined before the pane's first read since a start or reconnect. */
  view: ThreadStatusView | undefined
  /** Something the thread will see first is still on its way (§4.6). */
  held: boolean
}

export type ThreadStatusDecision =
  | { kind: 'wait' }
  | { kind: 'disarm' }
  | { kind: 'post'; text: string; stop: boolean }

const WAIT: ThreadStatusDecision = { kind: 'wait' }
const DISARM: ThreadStatusDecision = { kind: 'disarm' }

export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/** Lines posted today, by the fact's day. */
export function linesToday(fact: ThreadStatusFact, now: number): number {
  return fact.day === utcDay(now) ? fact.dayCount : 0
}

export function decideThreadStatus({
  now,
  eligible,
  fact,
  view,
  held
}: ThreadStatusInput): ThreadStatusDecision {
  const armed = fact?.armed
  if (!fact || !armed) {
    return WAIT
  }
  if (!eligible) {
    return DISARM
  }
  if (view === undefined) {
    return WAIT
  }
  if (view.activity === 'none') {
    return DISARM
  }
  if (
    !view.open ||
    now - armed.turnEndAt >= THREAD_STATUS_MAX_MS ||
    linesToday(fact, now) >= THREAD_STATUS_DAY_CAP
  ) {
    return held ? WAIT : { kind: 'post', text: THREAD_STATUS_STOP_LINE, stop: true }
  }
  if (held || now - armed.lastLineAt < THREAD_STATUS_DUE_MS[armed.dueStep]) {
    return WAIT
  }
  const elapsed = threadStatusElapsed(now - armed.at)
  const working = view.activity !== 'idle' || view.helpersRunning
  return {
    kind: 'post',
    text: working ? THREAD_STATUS_WORKING_LINE(elapsed) : THREAD_STATUS_IDLE_LINE(elapsed),
    stop: false
  }
}

/** `35 min`, `1 h 30 min`, `5 h`. */
export function threadStatusElapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS))
  if (minutes < 60) {
    return `${minutes} min`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}
