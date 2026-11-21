import type { ManagedRuntime, ManagedRuntimePin } from './managed-runtime-release'

const REFRESH_MS = 60 * 60_000

/** Follow a published latest release, looked up at most hourly; a failed lookup keeps the last known release. */
export function followLatestRelease(
  fetchLatest: (signal?: AbortSignal) => Promise<ManagedRuntimePin | null>
): Required<Pick<ManagedRuntime, 'pin' | 'refreshPin'>> {
  let latest: { pin: ManagedRuntimePin | null; at: number } | null = null
  let lookup: Promise<void> | null = null
  return {
    pin: () => latest?.pin ?? null,
    refreshPin: async (signal) => {
      if (latest && Date.now() - latest.at < REFRESH_MS) {
        return
      }
      lookup ??= fetchLatest(signal)
        .then((pin) => {
          latest = { pin, at: Date.now() }
        })
        .finally(() => {
          lookup = null
        })
      await lookup
    }
  }
}
