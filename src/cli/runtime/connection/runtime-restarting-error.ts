import type { RuntimeRestartMarker } from '../../../shared/remote-runtime/bootstrap/runtime-restart-marker'
import { resolveInvokedCliCommand } from '../../orchestration/recovery/runtime-compatibility'
import { RuntimeClientError } from './types'

// Agents read this; it must not send them to `orca open` or make them abandon the CLI.
export function runtimeRestartingError(restart: RuntimeRestartMarker): RuntimeClientError {
  return new RuntimeClientError(
    'runtime_unavailable',
    'Orca is restarting (an update or relaunch is in progress). Your terminal session is still running.',
    {
      requestSent: false,
      restarting: { reason: restart.reason, since: new Date(restart.writtenAt).toISOString() },
      nextSteps: [
        `Wait a few seconds and run the command again. Don't run '${resolveInvokedCliCommand()} open'.`
      ]
    }
  )
}

export function runtimeRestartedSincePreflightError(): RuntimeClientError {
  return new RuntimeClientError(
    'runtime_unavailable',
    'Orca restarted after this command checked what it supports, so nothing was sent.',
    {
      requestSent: false,
      nextSteps: ['Run the command again; it checks the restarted Orca first.']
    }
  )
}
