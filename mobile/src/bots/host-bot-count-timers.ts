// A host's Needs you counts change on their own when an item goes stale or a snoozed one comes back;
// nothing announces that, so the bot list reads the host again when its last read said it would.

// setTimeout's longest wait; a later change waits again from the read it brings.
const MAX_TIMER_MS = 2 ** 31 - 1
// The host counts with its own clock, so the read waits a little past it.
const COUNT_READ_MARGIN_MS = 1000

export function createHostCountTimers<Host extends { hostId: string }>(
  read: (host: Host) => void
): {
  /** Reads `host` again when its listing's counts next change; none, or no listing, reads nothing. */
  readAfter: (host: Host, listing: { needsYouChangeInMs?: number } | null) => void
  stop: () => void
} {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  return {
    readAfter: (host, listing) => {
      clearTimeout(timers.get(host.hostId))
      timers.delete(host.hostId)
      const inMs = listing?.needsYouChangeInMs
      if (inMs === undefined) {
        return
      }
      const wait = Math.min(Math.max(inMs, 0) + COUNT_READ_MARGIN_MS, MAX_TIMER_MS)
      timers.set(
        host.hostId,
        setTimeout(() => {
          timers.delete(host.hostId)
          read(host)
        }, wait)
      )
    },
    stop: () => {
      timers.forEach((timer) => clearTimeout(timer))
      timers.clear()
    }
  }
}
