import {
  resolveUnreportedExitCause,
  type TerminalExitCause
} from '../../shared/terminal-exit-cause'
import type { SessionOptions } from './session-options'

export function createSessionInitialOutput({
  sessionId,
  reportReadinessEvent
}: Pick<SessionOptions, 'sessionId' | 'reportReadinessEvent'>) {
  return {
    resolveExit(
      code: number,
      cause: TerminalExitCause | undefined,
      incarnationId: string
    ): TerminalExitCause {
      const resolved = cause ?? resolveUnreportedExitCause(code)
      if (resolved.kind === 'exited' && resolved.initialOutputDiagnostic) {
        try {
          reportReadinessEvent?.('session-initial-output-diagnostic', {
            sessionId,
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
