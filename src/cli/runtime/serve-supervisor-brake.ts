import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Failures inside this window count toward giving up; older ones have aged out. */
export const SERVE_SUPERVISOR_FAILURE_WINDOW_MS = 15 * 60_000
/** This many failures inside the window and the supervisor gives up until a new build or --force. */
export const SERVE_SUPERVISOR_FAILURE_LIMIT = 6
export const SERVE_SUPERVISOR_BACKOFF_BASE_MS = 1_000
export const SERVE_SUPERVISOR_BACKOFF_MAX_MS = 30_000
export const SERVE_SUPERVISOR_STANDBY_BASE_MS = 5_000
export const SERVE_SUPERVISOR_STANDBY_MAX_MS = 60_000
/** One piece of advice wherever a give-up is reported; reinstalling the service clears the brake. */
export const SERVE_GAVE_UP_ADVICE =
  'Fix the cause, then run `orca serve service install` again (or, outside a service, `orca serve --supervise --force` once).'

/**
 * Durable per profile, so the brake survives the service manager restarting the supervisor:
 * launchd has no start-limit key and would otherwise loop forever.
 */
export type ServeSupervisorBrake = {
  schemaVersion: 1
  /** Identity of the installed app build the failures were counted against. */
  build: string
  failures: number[]
  gaveUp: { at: number; reason: string } | null
}

export type SupervisedExitAction =
  | { kind: 'restart'; delayMs: number }
  | { kind: 'give-up'; reason: string }

export function serveSupervisorBrakePath(userDataPath: string): string {
  return join(userDataPath, 'serve-supervisor-brake.json')
}

export function emptyServeSupervisorBrake(build: string): ServeSupervisorBrake {
  return { schemaVersion: 1, build, failures: [], gaveUp: null }
}

/** A record for another build starts over: a new install deserves a fresh try. */
export function brakeForBuild(
  record: ServeSupervisorBrake | null,
  build: string
): ServeSupervisorBrake {
  return record && record.build === build ? record : emptyServeSupervisorBrake(build)
}

/** Pure: counts one unexpected exit and says how long to wait, or that it is time to stop. */
export function recordSupervisedFailure(
  record: ServeSupervisorBrake,
  input: { now: number; reason: string; random: () => number }
): { record: ServeSupervisorBrake; action: SupervisedExitAction } {
  const failures = [
    ...record.failures.filter(
      (at) => at <= input.now && input.now - at < SERVE_SUPERVISOR_FAILURE_WINDOW_MS
    ),
    input.now
  ]
  if (failures.length >= SERVE_SUPERVISOR_FAILURE_LIMIT) {
    const reason = `Orca serve failed ${failures.length} times in ${SERVE_SUPERVISOR_FAILURE_WINDOW_MS / 60_000} minutes; the supervisor stopped restarting it. Last failure: ${input.reason}`
    return {
      record: { ...record, failures, gaveUp: { at: input.now, reason } },
      action: { kind: 'give-up', reason }
    }
  }
  return {
    record: { ...record, failures },
    action: {
      kind: 'restart',
      delayMs: jitter(
        Math.min(
          SERVE_SUPERVISOR_BACKOFF_MAX_MS,
          SERVE_SUPERVISOR_BACKOFF_BASE_MS * 2 ** (failures.length - 1)
        ),
        input.random
      )
    }
  }
}

/** While another process serves the profile: wait longer each time, never count it as a failure. */
export function standbyDelayMs(attempt: number, random: () => number): number {
  return jitter(
    Math.min(SERVE_SUPERVISOR_STANDBY_MAX_MS, SERVE_SUPERVISOR_STANDBY_BASE_MS * 2 ** attempt),
    random
  )
}

function jitter(ms: number, random: () => number): number {
  // Why ±20%: services on one machine that failed together should not retry in lockstep.
  return Math.round(ms * (0.8 + 0.4 * random()))
}

export function parseServeSupervisorBrake(value: unknown): ServeSupervisorBrake | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  if (
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('build' in value) ||
    typeof value.build !== 'string' ||
    !('failures' in value) ||
    !Array.isArray(value.failures) ||
    !('gaveUp' in value)
  ) {
    return null
  }
  const failures = value.failures.filter((at): at is number => typeof at === 'number')
  const gaveUp = value.gaveUp
  const parsedGaveUp =
    typeof gaveUp === 'object' &&
    gaveUp !== null &&
    'at' in gaveUp &&
    typeof gaveUp.at === 'number' &&
    'reason' in gaveUp &&
    typeof gaveUp.reason === 'string'
      ? { at: gaveUp.at, reason: gaveUp.reason }
      : null
  return { schemaVersion: 1, build: value.build, failures, gaveUp: parsedGaveUp }
}

export function readServeSupervisorBrake(userDataPath: string): ServeSupervisorBrake | null {
  try {
    return parseServeSupervisorBrake(
      JSON.parse(readFileSync(serveSupervisorBrakePath(userDataPath), 'utf8'))
    )
  } catch {
    return null
  }
}

export function writeServeSupervisorBrake(
  userDataPath: string,
  record: ServeSupervisorBrake
): void {
  const target = serveSupervisorBrakePath(userDataPath)
  const temporary = `${target}.${process.pid}.tmp`
  try {
    // Why: a service's first run can fail before the server ever created its profile.
    mkdirSync(userDataPath, { recursive: true, mode: 0o700 })
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 })
    renameSync(temporary, target)
  } catch (error) {
    // Fail open: an unwritable profile only loses the count across a supervisor restart.
    process.stderr.write(`[serve] could not record supervisor restarts: ${String(error)}\n`)
  }
}

export function clearServeSupervisorBrake(userDataPath: string): void {
  try {
    rmSync(serveSupervisorBrakePath(userDataPath), { force: true })
  } catch {
    // Nothing recorded, or a read-only profile: nothing of ours to clear.
  }
}
