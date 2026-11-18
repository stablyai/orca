import type { Session } from '../sessions/session'
import {
  discardStagedStartupCommandAsync,
  stageStartupCommandAsync,
  startupStagingFailureNotice,
  type StartupCommandStaging
} from '../../../shared/shell/launch/startup-command-staging'
import { buildStartupCommandSubmission } from '../../../shared/shell/launch/startup-command-submission'
import type { TerminalHostSessionCreateDependencies } from './terminal-host-session-create'

// Explicit inputs: closures in the create scope share it with session-lifetime callbacks.
export type StartupSubmissionInputs = {
  staging: { current?: StartupCommandStaging }
  session: Session
  shellPath: string | undefined
  orcaBuiltLine: boolean
  shellReadySupported: boolean
  sessionId: string
  reportReadinessEvent: TerminalHostSessionCreateDependencies['reportReadinessEvent']
}

export async function buildStartupSubmission(
  command: string,
  inputs: StartupSubmissionInputs
): Promise<string> {
  const staged = await stageStartupCommandAsync({
    command,
    shellPath: inputs.shellPath,
    orcaBuiltLine: inputs.orcaBuiltLine
  })
  if (!inputs.session.isAlive) {
    // The exit handler already ran, so it can't remove a script staged after it.
    void discardStagedStartupCommandAsync(staged)
  }
  inputs.staging.current = staged
  const notice = startupStagingFailureNotice(staged)
  if (notice) {
    inputs.session.startupIngress.accept(notice)
    try {
      inputs.reportReadinessEvent?.('startup-command-stage-failed', {
        sessionId: inputs.sessionId,
        reason: staged.failure
      })
    } catch {
      // Diagnostics must never turn a live PTY into a failed create.
    }
  }
  // Why: only Orca-wrapped shells advertise the paste-safe startup barrier.
  return buildStartupCommandSubmission(staged.command, {
    bracketedPasteSafe: inputs.shellReadySupported
  })
}
