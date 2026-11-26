import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'
import type { ManagedRuntime, ManagedRuntimePin } from './managed-runtime-release'

const REFRESH_MS = 60 * 60_000
// Callers join one lookup, so it has its own deadline: no caller's signal may end it for the rest.
const LOOKUP_DEADLINE_MS = 60_000

export type HourlyLookup<T> = {
  /** The last value a lookup answered, or undefined before one has. */
  latest: () => T | undefined
  /** Look up again when the last answer is over an hour old, joining one in flight; `signal` ends only this wait. */
  refresh: (signal?: AbortSignal) => Promise<void>
}

/** A failed lookup keeps the last known value and is retried on the next refresh. */
export function hourlyLookup<T>(
  fetchLatest: (signal?: AbortSignal) => Promise<T>
): HourlyLookup<T> {
  let latest: { value: T; at: number } | null = null
  let lookup: Promise<void> | null = null
  return {
    latest: () => latest?.value,
    refresh: async (signal) => {
      if (latest && Date.now() - latest.at < REFRESH_MS) {
        return
      }
      lookup ??= lookUp()
      await waitForPromiseWithSignal(lookup, signal)
    }
  }

  function lookUp(): Promise<void> {
    const deadline = AbortSignal.timeout(LOOKUP_DEADLINE_MS)
    return fetchLatest(deadline)
      .then(
        (value) => {
          latest = { value, at: Date.now() }
        },
        (error: unknown) => {
          // Install surfaces show this text, so say what stalled instead of a bare timeout.
          throw deadline.aborted
            ? new Error('Looking up the latest release took longer than a minute. Try again.', {
                cause: error
              })
            : error
        }
      )
      .finally(() => {
        lookup = null
      })
  }
}

/** Follow a published latest release, looked up at most hourly; a failed lookup keeps the last known release. */
export function followLatestRelease(
  fetchLatest: (signal?: AbortSignal) => Promise<ManagedRuntimePin | null>
): Required<Pick<ManagedRuntime, 'pin' | 'refreshPin'>> {
  const release = hourlyLookup(fetchLatest)
  return { pin: () => release.latest() ?? null, refreshPin: release.refresh }
}
