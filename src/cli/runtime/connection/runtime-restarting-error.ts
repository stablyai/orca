import {
  isRuntimeRestartOverdue,
  type RuntimeRestartMarker
} from '../../../shared/remote-runtime/bootstrap/runtime-restart-marker'
import { resolveInvokedCliCommand } from '../../orchestration/recovery/runtime-compatibility'
import { RuntimeClientError } from './types'

// Agents read this; it must not send them to `orca open` or make them abandon the CLI.
export function runtimeRestartingError(
  restart: RuntimeRestartMarker,
  now = Date.now()
): RuntimeClientError {
  const command = resolveInvokedCliCommand()
  if (isRuntimeRestartOverdue(restart, now)) {
    // A restart this late may have failed; the user decides whether to reopen Orca.
    const seconds = Math.round((now - restart.writtenAt) / 1000)
    return new RuntimeClientError(
      'runtime_unavailable',
      `Orca restarted ${seconds} s ago but hasn't come back, so it may be down. Your terminal session is still running.`,
      {
        requestSent: false,
        restarting: runtimeRestartingData(restart, now),
        nextSteps: [
          `Tell the user Orca may need to be reopened. Run '${command} open' only if they ask.`
        ]
      }
    )
  }
  return new RuntimeClientError(
    'runtime_unavailable',
    'Orca is restarting (an update or relaunch is in progress). Your terminal session is still running.',
    {
      requestSent: false,
      restarting: runtimeRestartingData(restart, now),
      nextSteps: [`Wait a few seconds and run the command again. Don't run '${command} open'.`]
    }
  )
}

/** The `restarting` field of errors and `orca status`; `overdue` means Orca may be down. */
export function runtimeRestartingData(
  restart: RuntimeRestartMarker,
  now: number
): { reason: RuntimeRestartMarker['reason']; since: string; overdue?: true } {
  return {
    reason: restart.reason,
    since: new Date(restart.writtenAt).toISOString(),
    ...(isRuntimeRestartOverdue(restart, now) ? { overdue: true as const } : {})
  }
}

export function runtimeRestartedSincePreflightError(): RuntimeClientError {
  return new RuntimeClientError(
    'runtime_unavailable',
    'Orca restarted while this command was running, so nothing was sent.',
    {
      requestSent: false,
      nextSteps: ['Run the command again; it checks the restarted Orca first.']
    }
  )
}

/** No nextSteps, so the CLI adds its plain "Orca isn't running right now" guidance. */
export function runtimeNotRunningError(): RuntimeClientError {
  return new RuntimeClientError(
    'runtime_unavailable',
    'Orca is not running: the process that last served this profile has exited.',
    { requestSent: false }
  )
}
