import type { Session } from './session'
import { buildStartupCommandSubmission } from '../../shared/startup-command-submission'
import {
  startupStagingFailureNotice,
  type StartupCommandStaging
} from '../../shared/startup-command-staging'

export function deliverStagedStartupCommand(
  session: Session,
  staging: StartupCommandStaging,
  windowsMultilineCommand: string | undefined,
  shellReadySupported: boolean,
  sessionId: string,
  reportReadinessEvent?: (event: string, details: Record<string, unknown>) => void
): void {
  if (windowsMultilineCommand && staging.failure) {
    session.startupIngress.accept(
      `\r\n[orca] Could not stage the startup script (${staging.failure}); nothing was run.\r\n`
    )
  } else {
    const notice = startupStagingFailureNotice(staging)
    if (notice) {
      session.startupIngress.accept(notice)
      try {
        reportReadinessEvent?.('startup-command-stage-failed', {
          sessionId: sessionId,
          reason: staging.failure
        })
      } catch {
        // Diagnostics must never turn a live PTY into a failed create.
      }
    }
    // Why: only Orca-wrapped shells advertise the paste-safe startup barrier.
    session.writeStartupCommand(
      buildStartupCommandSubmission(staging.command, {
        bracketedPasteSafe: shellReadySupported
      })
    )
  }
}
