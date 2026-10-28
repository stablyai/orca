import type { DaemonFileLog } from './daemon-file-log'

export const DAEMON_SHUTDOWN_TIMEOUT_MS = 5_000

type LiveSessionGroups = { killLiveSessionGroupsSync(): void }

/** Force exit if shutdown stalls, including RPC teardown. */
export function createDaemonShutdownDeadline(
  log: DaemonFileLog,
  liveSessions: () => LiveSessionGroups | null,
  exit: () => void = () => process.exit(0)
): { start: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    start: () => {
      if (timer) {
        return
      }
      timer = setTimeout(() => {
        log.log('shutdown-error', { message: 'shutdown timeout' })
        log.close()
        // Async teardown may still be reading the process table; never exit with its PTYs unsignalled.
        liveSessions()?.killLiveSessionGroupsSync()
        exit()
      }, DAEMON_SHUTDOWN_TIMEOUT_MS)
      timer.unref()
    },
    cancel: () => {
      clearTimeout(timer)
      timer = undefined
    }
  }
}
