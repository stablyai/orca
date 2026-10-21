import type {
  ConnectionDiagnosticsSubmission,
  ConnectionDiagnosticsSubmissionResult
} from './connection-diagnostics-submission'

/** A fresh report plus the incident it describes, so a stale send can be dropped. */
export type ConnectionDiagnosticsReport = ConnectionDiagnosticsSubmission & {
  incidentId: string | null
}

export interface DiagnosticsDeviceOperations {
  report(): Promise<ConnectionDiagnosticsReport>
  submit(
    submission: ConnectionDiagnosticsSubmission
  ): Promise<ConnectionDiagnosticsSubmissionResult>
}
