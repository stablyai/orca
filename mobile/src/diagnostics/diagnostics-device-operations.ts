import type {
  DiagnosticsSnapshot,
  DiagnosticsSubmission
} from '../../../src/shared/mobile-web/diagnostics-device-contract'
import type { ConnectionDiagnosticsSubmissionResult } from './connection-diagnostics-submission'

export interface DiagnosticsDeviceOperations {
  snapshot(): Promise<DiagnosticsSnapshot>
  probe(target: 'internet' | 'host'): Promise<{ reachable: boolean }>
  submit(payload: DiagnosticsSubmission): Promise<ConnectionDiagnosticsSubmissionResult>
}
