/** Cadence for the wedged-worker signal. See docs/reference/wedged-worker-detection.md. */
export type WorkerProgressThresholds = {
  /** Quiet time a `ready` dispatch may accumulate before it classifies as wedged. */
  wedgedAfterMs: number
  /** Minimum gap between two escalations for the same unchanged wedge. */
  reEscalateAfterMs: number
  /** Sampling period of the detector. Never the escalation cadence. */
  scanIntervalMs: number
  enabled: boolean
}

// Why 15 min: the preamble asks for a heartbeat every 5 minutes, so this is three
// missed heartbeats — long enough that a slow tool call or a long model turn never
// trips it, short enough to beat a coordinator's own 15-60 minute `check --wait`.
// Why 30 min re-escalation: a repeat must read as new information, not as a retry
// of the first one; the coordinator is told the count so it can tell them apart.
export const DEFAULT_WORKER_PROGRESS_THRESHOLDS: WorkerProgressThresholds = {
  wedgedAfterMs: 15 * 60_000,
  reEscalateAfterMs: 30 * 60_000,
  scanIntervalMs: 60_000,
  enabled: true
}

const MIN_WEDGED_AFTER_MS = 60_000
const MIN_SCAN_INTERVAL_MS = 5_000

export const WEDGED_WORKER_ENV_KEYS = {
  enabled: 'ORCA_WEDGED_WORKER_DETECTION',
  wedgedAfterMs: 'ORCA_WEDGED_WORKER_THRESHOLD_MS',
  reEscalateAfterMs: 'ORCA_WEDGED_WORKER_REESCALATION_MS',
  scanIntervalMs: 'ORCA_WEDGED_WORKER_SCAN_INTERVAL_MS'
} as const

function readPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function readEnabled(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  if (['0', 'off', 'false', 'no'].includes(normalized)) {
    return false
  }
  return ['1', 'on', 'true', 'yes'].includes(normalized) ? true : undefined
}

/**
 * Resolve thresholds from the environment, falling back to the documented defaults.
 * Every value is clamped so a typo cannot turn the detector into a spammer: the scan
 * never runs faster than 5 s, the wedge threshold never drops under a minute, and a
 * re-escalation never fires sooner than one full wedge threshold.
 */
export function resolveWorkerProgressThresholds(
  env: Record<string, string | undefined> = process.env
): WorkerProgressThresholds {
  const enabled = readEnabled(env[WEDGED_WORKER_ENV_KEYS.enabled])
  const wedgedAfterMs = Math.max(
    MIN_WEDGED_AFTER_MS,
    readPositiveInt(env[WEDGED_WORKER_ENV_KEYS.wedgedAfterMs]) ??
      DEFAULT_WORKER_PROGRESS_THRESHOLDS.wedgedAfterMs
  )
  const reEscalateAfterMs = Math.max(
    wedgedAfterMs,
    readPositiveInt(env[WEDGED_WORKER_ENV_KEYS.reEscalateAfterMs]) ??
      DEFAULT_WORKER_PROGRESS_THRESHOLDS.reEscalateAfterMs
  )
  const scanIntervalMs = Math.min(
    wedgedAfterMs,
    Math.max(
      MIN_SCAN_INTERVAL_MS,
      readPositiveInt(env[WEDGED_WORKER_ENV_KEYS.scanIntervalMs]) ??
        DEFAULT_WORKER_PROGRESS_THRESHOLDS.scanIntervalMs
    )
  )
  return {
    wedgedAfterMs,
    reEscalateAfterMs,
    scanIntervalMs,
    enabled: enabled ?? DEFAULT_WORKER_PROGRESS_THRESHOLDS.enabled
  }
}
