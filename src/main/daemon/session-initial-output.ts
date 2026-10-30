import { createGitBashConsoleCapacityDetector } from '../../shared/git-bash-console-capacity'
import {
  resolveUnreportedExitCause,
  type TerminalExitCause
} from '../../shared/terminal-exit-cause'
import { withInitialOutputDiagnostic } from '../../shared/terminal-start-failure'
import type { SessionOptions } from './session-options'

export function createSessionInitialOutput(opts: SessionOptions) {
  const detector =
    opts.ownerBackend === 'windows-conpty' ? createGitBashConsoleCapacityDetector(4096) : null
  return {
    observe(data: string): void {
      detector?.observe(data)
    },
    resolveExit(
      code: number,
      cause: TerminalExitCause | undefined,
      incarnationId: string
    ): TerminalExitCause {
      const resolved = withInitialOutputDiagnostic(
        cause ?? resolveUnreportedExitCause(code),
        detector?.detected() === true
      )
      if (resolved.kind === 'exited' && resolved.initialOutputDiagnostic) {
        try {
          opts.reportReadinessEvent?.('session-initial-output-diagnostic', {
            sessionId: opts.sessionId,
            incarnationId,
            code,
            diagnostic: resolved.initialOutputDiagnostic
          })
        } catch {
          // A diagnostic sink cannot change process settlement.
        }
      }
      return resolved
    }
  }
}
