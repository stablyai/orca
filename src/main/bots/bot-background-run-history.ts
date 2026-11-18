// A bot's background runs (looks, tidy-ups) as their record keeps them: the newest in full, the
// sessions of older ones, and which scheduled slot a run took.

export type LookAroundRun = {
  sessionId: string
  startedAt: number
  endedAt?: number
  error?: string
  /** Its failure reached the owner as a notification; only a failed turn can. */
  alerted?: true
  /** The host slept during it: missed, not failed, so it is tried again and never turns it off. */
  asleep?: true
  /** The agent's usage limit ended it: never a failure toward turning it off, and no scheduled
   *  run starts before `resetsAt`, when known. */
  usageLimited?: LookUsageLimit
}

export type LookUsageLimit = { resetsAt?: number }

/** A background run's history: the newest runs in full, and every older run's session, so those
 *  sessions are still known as runs (never chats) after the history drops them. */
export type BackgroundRuns = {
  runs: LookAroundRun[]
  pastSessionIds?: string[]
}

/** Adds a run, keeping the newest `max` in full; one trimmed off keeps its session id. */
export function withBackgroundRun<S extends BackgroundRuns>(
  state: S,
  sessionId: string,
  now: number,
  max: number
): S {
  const all: LookAroundRun[] = [...state.runs, { sessionId, startedAt: now }]
  // Runs a sleeping host cut short go first, so retries never push out what really happened.
  const over = all.length - max
  const cut = all.filter((run) => run.asleep === true).slice(0, Math.max(0, over))
  const kept = all.filter((run) => !cut.includes(run))
  const trimmed = [...cut, ...kept.slice(0, -max)].map((run) => run.sessionId)
  return {
    ...state,
    runs: kept.slice(-max),
    ...(trimmed.length > 0 ? { pastSessionIds: [...(state.pastSessionIds ?? []), ...trimmed] } : {})
  }
}

/** Cut short by the host's sleep or a usage limit: the run never used its slot up. */
function missedRun(run: LookAroundRun): boolean {
  return run.asleep === true || run.usageLimited !== undefined
}

/** After a run the host's sleep cut short, the slot is tried again no sooner than this. */
export const ASLEEP_RETRY_AFTER_MS = 15 * 60 * 1000

/** Whether a slot already had its run, as of `now`. A run the host's sleep cut short never uses
 *  the slot up, however often it happens: the slot is tried again, only waiting a little after
 *  each, so a host that keeps sleeping doesn't start one every tick. */
export function slotTaken(runs: readonly LookAroundRun[], slot: number, now: number): boolean {
  const since = runs.filter((run) => run.startedAt >= slot)
  if (since.some((run) => !missedRun(run))) {
    return true
  }
  const cut = since.at(-1)
  return cut !== undefined && now - (cut.endedAt ?? cut.startedAt) < ASLEEP_RETRY_AFTER_MS
}

/** When the last run that was not cut short by sleep or a usage limit started; 0 when none was. */
export function lastRunStartedAt(runs: readonly LookAroundRun[]): number {
  return runs.findLast((run) => !missedRun(run))?.startedAt ?? 0
}

/** Takes back a run that never sent its opening message, so its slot stays open; its session
 *  stays known as a run's, never a chat. */
export function withoutBackgroundRun<S extends BackgroundRuns>(
  state: S,
  sessionId: string,
  /** The history just before the run began: an older run its begin trimmed is put back. */
  before?: BackgroundRuns
): S {
  if (!state.runs.some((run) => run.sessionId === sessionId)) {
    return state
  }
  return {
    ...state,
    runs: before ? before.runs : state.runs.filter((run) => run.sessionId !== sessionId),
    pastSessionIds: [...((before ?? state).pastSessionIds ?? []), sessionId]
  }
}

/** The run is one of these: in the newest runs or an older one. */
export function backgroundRunSessionIds(state: BackgroundRuns): string[] {
  return [...(state.pastSessionIds ?? []), ...state.runs.map((run) => run.sessionId)]
}
