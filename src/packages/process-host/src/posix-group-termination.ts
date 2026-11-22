import type { ChildProcess } from 'node:child_process'
import {
  signalProcessTree,
  forceTerminateProcessTree,
  processGroupExists
} from './process-tree-termination'

// Bound waits for children that ignore TERM.
export const PROCESS_EXIT_GRACE_MS = 2_000

/** Only for children launched in an owned native POSIX group. Normal close preserves hook daemons. */
export function createPosixGroupTermination(
  child: ChildProcess,
  onTerminated: () => void
): { stop: () => Promise<boolean>; close: () => void } {
  let stopping = false
  let reported = false
  let attempt: Promise<boolean> | undefined
  let grace: ReturnType<typeof setTimeout> | undefined
  let resolveAttempt: ((verified: boolean) => void) | undefined
  const report = (): void => {
    if (reported) {
      return
    }
    reported = true
    clearTimeout(grace)
    onTerminated()
    resolveAttempt?.(true)
  }
  const absent = (): boolean => !child.pid || !processGroupExists(child.pid)
  return {
    stop() {
      if (attempt) {
        return attempt
      }
      stopping = true
      attempt = new Promise<boolean>((resolve) => {
        resolveAttempt = resolve
      })
      if (reported || absent()) {
        report()
        resolveAttempt?.(true)
        return attempt
      }
      void signalProcessTree(child).catch(() => false)
      if (absent()) {
        report()
        return attempt
      }
      // Close after TERM never cancels force unless the entire group is proven absent.
      grace = setTimeout(() => {
        void forceTerminateProcessTree(child)
          .catch(() => false)
          .then((verified) => {
            if (verified) {
              report()
            } else {
              try {
                child.kill('SIGKILL')
              } catch {
                /* handle already closed */
              }
            }
            resolveAttempt?.(verified)
          })
      }, PROCESS_EXIT_GRACE_MS)
      grace.unref?.()
      return attempt
    },
    close() {
      if (!stopping || absent()) {
        report()
      }
    }
  }
}
