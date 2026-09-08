import {
  DiagnosticsEmptyPayloadSchema,
  DiagnosticsSnapshotResultSchema,
  DiagnosticsProbePayloadSchema,
  DiagnosticsProbeResultSchema,
  DiagnosticsSubmitPayloadSchema,
  DiagnosticsSubmitResultSchema,
  type DiagnosticsSubmission
} from '../../shared/mobile-web/diagnostics-device-contract'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebDiagnosticsDeviceClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}
  snapshot() {
    return this.requests.request(
      'native',
      'diagnosticsSnapshot',
      {},
      DiagnosticsEmptyPayloadSchema,
      DiagnosticsSnapshotResultSchema
    )
  }
  probe(target: 'internet' | 'host') {
    return this.requests.request(
      'native',
      'diagnosticsProbe',
      { target },
      DiagnosticsProbePayloadSchema,
      DiagnosticsProbeResultSchema
    )
  }
  submit(payload: DiagnosticsSubmission) {
    return this.requests.request(
      'native',
      'diagnosticsSubmit',
      payload,
      DiagnosticsSubmitPayloadSchema,
      DiagnosticsSubmitResultSchema,
      { timeoutMs: 15_000 }
    )
  }
}
