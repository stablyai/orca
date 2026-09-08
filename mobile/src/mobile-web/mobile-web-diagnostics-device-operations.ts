import {
  DiagnosticsEmptyPayloadSchema,
  DiagnosticsSnapshotResultSchema,
  DiagnosticsProbePayloadSchema,
  DiagnosticsProbeResultSchema,
  DiagnosticsSubmitPayloadSchema,
  DiagnosticsSubmitResultSchema
} from '../../../src/shared/mobile-web/diagnostics-device-contract'
import type { DiagnosticsDeviceOperations } from '../diagnostics/diagnostics-device-operations'
import { MobileWebBrokerError } from './mobile-web-broker-error'

export async function executeDiagnosticsDeviceOperation(
  operation: string,
  payload: unknown,
  authority?: DiagnosticsDeviceOperations
) {
  if (operation === 'diagnosticsSnapshot') {
    DiagnosticsEmptyPayloadSchema.parse(payload)
    if (!authority) {
      throw new MobileWebBrokerError('unavailable')
    }
    return DiagnosticsSnapshotResultSchema.parse(await authority.snapshot())
  }
  if (operation === 'diagnosticsProbe') {
    const { target } = DiagnosticsProbePayloadSchema.parse(payload)
    if (!authority) {
      throw new MobileWebBrokerError('unavailable')
    }
    return DiagnosticsProbeResultSchema.parse(await authority.probe(target))
  }
  const submission = DiagnosticsSubmitPayloadSchema.parse(payload)
  if (!authority) {
    throw new MobileWebBrokerError('unavailable')
  }
  return DiagnosticsSubmitResultSchema.parse(await authority.submit(submission))
}
