/** Serve-time overrides for worker auto-release, for runtimes that no local Settings window can reach. */
export const WORKER_AUTO_RELEASE_ENV = 'ORCA_WORKER_AUTO_RELEASE'
export const WORKER_AUTO_RELEASE_GRACE_ENV = 'ORCA_WORKER_AUTO_RELEASE_GRACE_SECONDS'

// A week bounds a typo such as an extra zero; past that, turning auto-release off says what was meant.
const MAX_GRACE_SECONDS = 7 * 24 * 60 * 60

export type WorkerAutoReleaseEnvironment = {
  /** Set only when the environment decides; otherwise the user's setting does. */
  enabled?: boolean
  graceMs?: number
  /** Names of variables that were set but not understood, and so ignored. */
  invalid: string[]
}

export function readWorkerAutoReleaseEnvironment(
  env: NodeJS.ProcessEnv
): WorkerAutoReleaseEnvironment {
  const result: WorkerAutoReleaseEnvironment = { invalid: [] }
  const switchValue = env[WORKER_AUTO_RELEASE_ENV]?.trim().toLowerCase()
  if (switchValue === 'on' || switchValue === 'off') {
    result.enabled = switchValue === 'on'
  } else if (switchValue) {
    result.invalid.push(WORKER_AUTO_RELEASE_ENV)
  }
  const graceValue = env[WORKER_AUTO_RELEASE_GRACE_ENV]?.trim()
  if (graceValue) {
    const seconds = /^\d+$/.test(graceValue) ? Number(graceValue) : Number.NaN
    if (seconds >= 1 && seconds <= MAX_GRACE_SECONDS) {
      result.graceMs = seconds * 1_000
    } else {
      result.invalid.push(WORKER_AUTO_RELEASE_GRACE_ENV)
    }
  }
  return result
}
