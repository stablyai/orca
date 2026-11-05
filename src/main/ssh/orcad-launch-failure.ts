import { OrcadWindowsLaunchFailedError } from '../managed-server/install/orcad-remote-launch-windows'
import { OrcadLaunchReadinessError } from './orcad-active-readiness'

/** A launch that ended a run: it never became ready, or the host reported it could not start. */
export function isOrcadLaunchFailure(error: unknown): error is Error {
  return (
    error instanceof OrcadLaunchReadinessError || error instanceof OrcadWindowsLaunchFailedError
  )
}

/** Only a readiness failure had a running orcad, whose death the next orcad will report. */
export function orcadLaunchFailureRanProcess(error: Error): boolean {
  return error instanceof OrcadLaunchReadinessError
}
