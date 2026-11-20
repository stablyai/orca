import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'
import type { ManagedRuntime, ManagedRuntimePin } from './managed-runtime-release'

const REFRESH_MS = 60 * 60_000
// Callers join one lookup, so it has its own deadline: no caller's signal may end it for the rest.
const LOOKUP_DEADLINE_MS = 60_000

export type HourlyLookup<T> = {
  /** The last value a lookup answered, or undefined before one has. */
  latest: () => T | undefined
  /** Look up again when the last answer is over an hour old, joining a lookup in flight; `signal` ends only this wait. */
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
      lookup ??= fetchLatest(AbortSignal.timeout(LOOKUP_DEADLINE_MS))
        .then((value) => {
          latest = { value, at: Date.now() }
        })
        .finally(() => {
          lookup = null
        })
      await waitForPromiseWithSignal(lookup, signal)
    }
  }
}

/** Follow a published latest release, looked up at most hourly; a failed lookup keeps the last known release. */
export function followLatestRelease(
  fetchLatest: (signal?: AbortSignal) => Promise<ManagedRuntimePin | null>
): Required<Pick<ManagedRuntime, 'pin' | 'refreshPin'>> {
  const release = hourlyLookup(fetchLatest)
  return { pin: () => release.latest() ?? null, refreshPin: release.refresh }
}

/** Look up the latest release before an install; a failed lookup installs the last known one, as status reads keep it. */
export async function refreshRuntimePin(
  runtime: ManagedRuntime,
  signal: AbortSignal
): Promise<void> {
  await runtime.refreshPin?.(signal).catch((error: unknown) => {
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
