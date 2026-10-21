import type { DaemonFileLog } from './daemon-file-log'

export const DAEMON_SHUTDOWN_TIMEOUT_MS = 5_000

/** Bounds every process shutdown, including RPC teardown that never settles. */
export function createDaemonShutdownDeadline(
  log: DaemonFileLog,
  exit: () => void
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
