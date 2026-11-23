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
        if (incarnationId) {
          runtime.recordInProcessPtyExit(`${id}:${incarnationId}`)
        }
      })
    : null
}
