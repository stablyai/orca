import type { ManagedRuntime, ManagedRuntimePin } from './managed-runtime-release'

const REFRESH_MS = 60 * 60_000

export type HourlyLookup<T> = {
  /** The last value a lookup answered, or undefined before one has. */
  latest: () => T | undefined
  /** Look up again when the last answer is over an hour old, joining a lookup in flight. */
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
      lookup ??= fetchLatest(signal)
        .then((value) => {
          latest = { value, at: Date.now() }
        })
        .finally(() => {
          lookup = null
        })
      await lookup
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
