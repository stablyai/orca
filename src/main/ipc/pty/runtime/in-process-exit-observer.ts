import { onLocalPtyExit } from '../../../providers/local-pty/local-pty-session-operations'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'

// Window reactivation reinstalls the PTY controller; keep one exit observer.
let stopObservingInProcessExits: (() => void) | null = null

/** Feed this process's own PTY exits to the runtime's exit proof; replaces any earlier observer. */
export function observeInProcessWorkerExits(
  runtime: Pick<OrcaRuntimeService, 'recordInProcessPtyExit'> | undefined
): void {
  stopObservingInProcessExits?.()
  stopObservingInProcessExits = runtime
    ? onLocalPtyExit(({ id, incarnationId }) => {
        if (!incarnationId) {
          return
        }
        // The provider's exit loop is unguarded: a throw here would skip every later exit listener.
        try {
          runtime.recordInProcessPtyExit(`${id}:${incarnationId}`)
        } catch (error) {
          console.warn('[orchestration] could not record a terminal exit for release proof', {
            error
          })
        }
      })
    : null
}
