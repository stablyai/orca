// This computer's failed bots read is read again on its own, a few times with growing waits, since
// nothing else may come to ask; a later change or reconnect reads it too.
import { HOST_REFRESH_FALLBACK_MS } from '../worktree/execution-hosts/host-worktree-refresh'

const FAILED_READ_RETRIES = 5

export function createFailedReadRetries<Host extends { hostId: string }>(
  read: (host: Host) => void
): {
  /** After each read: a failed one is read again later, any other ends the retries. */
  readAfter: (host: Host, failed: boolean) => void
  stop: () => void
} {
  const failures = new Map<string, { count: number; timer: ReturnType<typeof setTimeout> }>()
  return {
    readAfter: (host, failed) => {
      const last = failures.get(host.hostId)
      clearTimeout(last?.timer)
      failures.delete(host.hostId)
      const count = failed ? (last?.count ?? 0) + 1 : 0
      if (count === 0 || count > FAILED_READ_RETRIES) {
        return
      }
      const wait = HOST_REFRESH_FALLBACK_MS * 2 ** (count - 1)
      failures.set(host.hostId, { count, timer: setTimeout(() => read(host), wait) })
    },
    stop: () => {
      failures.forEach(({ timer }) => clearTimeout(timer))
      failures.clear()
    }
  }
}
