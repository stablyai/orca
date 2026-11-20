import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'
import type { ManagedRuntime, ManagedRuntimePin } from './managed-runtime-release'

const REFRESH_MS = 60 * 60_000
// Callers join one lookup, so it has its own deadline: no caller's signal may end it for the rest.
const LOOKUP_DEADLINE_MS = 60_000

export type HourlyLookup<T> = {
  /** The last value a lookup answered, or undefined before one has. */
  latest: () => T | undefined
  /** Whether the last lookup failed before any answered, so the value is unknown rather than absent. */
  failed: () => boolean
  /**
   * Look up again when the last lookup is over an hour old, joining one in flight; `signal` ends only this wait.
   * `retryFailed` looks again after a failure while nothing is known, for an install the user asked for.
   */
  refresh: (signal?: AbortSignal, retryFailed?: boolean) => Promise<void>
}

/**
 * A failed lookup counts as a check too: it keeps the last known value and waits the hour like a success.
 * While nothing is known, refreshes in that hour answer with its error, so no one reads silence as "no release".
 */
export function hourlyLookup<T>(
  fetchLatest: (signal?: AbortSignal, retryFailed?: boolean) => Promise<T>
): HourlyLookup<T> {
  let latest: { value: T } | null = null
  let checkedAt: number | null = null
  let failure: { error: unknown } | null = null
  let lookup: Promise<void> | null = null
  return {
    latest: () => latest?.value,
    failed: () => failure !== null && !latest,
    refresh: async (signal, retryFailed = false) => {
      const recent = checkedAt !== null && Date.now() - checkedAt < REFRESH_MS
      if (recent && !(retryFailed && !latest) && !lookup) {
        if (failure && !latest) {
          throw failure.error
        }
        return
      }
      if (!lookup) {
        checkedAt = Date.now()
        lookup = fetchLatest(AbortSignal.timeout(LOOKUP_DEADLINE_MS), retryFailed)
          .then(
            (value) => {
              latest = { value }
              failure = null
            },
            (error: unknown) => {
              failure = { error }
              throw error
            }
          )
          .finally(() => {
            lookup = null
          })
      }
      await waitForPromiseWithSignal(lookup, signal)
    }
  }
}

/** Follow a published latest release, looked up at most hourly; a failed lookup keeps the last known release. */
export function followLatestRelease(
  fetchLatest: (signal?: AbortSignal, retryFailed?: boolean) => Promise<ManagedRuntimePin | null>
): Required<Pick<ManagedRuntime, 'pin' | 'refreshPin' | 'pinUnknown'>> {
  const release = hourlyLookup(fetchLatest)
  return {
    pin: () => release.latest() ?? null,
    refreshPin: release.refresh,
    pinUnknown: release.failed
  }
}

const loggedLookupErrors = new WeakMap<ManagedRuntime, unknown>()

/** Look up the latest release for a status read; a failure answers every read of its hour, so it is logged once. */
export async function refreshPinForStatus(runtime: ManagedRuntime, agent: string): Promise<void> {
  await runtime.refreshPin?.().catch((error: unknown) => {
    if (loggedLookupErrors.get(runtime) !== error) {
      console.warn(`[managed-runtime] ${agent} latest release unknown:`, error)
    }
    loggedLookupErrors.set(runtime, error)
  })
}

/** Look up the latest release before an install; a failed lookup installs the last known one, as status reads keep it. */
export async function refreshRuntimePin(
  runtime: ManagedRuntime,
  signal: AbortSignal
): Promise<void> {
  await runtime.refreshPin?.(signal, true).catch((error: unknown) => {
    signal.throwIfAborted()
    if (runtime.pin()) {
      console.warn(
        `[managed-runtime] ${runtime.label} latest release unknown; installing the last known:`,
        error
      )
      return
    }
    throw new Error(
      `Couldn't look up the latest ${runtime.label} release. Check your connection and try again.`,
      { cause: error }
    )
  })
}
