import type { MobilePairingConnectionContext } from '../runtime-rpc'
import type {
  MobileRelayEndpoint,
  PairingGetEndpointsParams,
  PairingGetEndpointsResult
} from '../../../shared/mobile-relay-credential-contract'
import type { RelaySessionBroker } from './relay-session-broker'

// Assembles the endpoint answer for a device the host is willing to serve
// over Relay; the caller owns the policy gate and the host/broker checks.
export async function buildPairingEndpointsResult(args: {
  broker: RelaySessionBroker
  endpoint: MobileRelayEndpoint
  context: MobilePairingConnectionContext
  params: PairingGetEndpointsParams
}): Promise<PairingGetEndpointsResult> {
  const { broker, context, params } = args
  const result: PairingGetEndpointsResult = { v: 1, relay: args.endpoint }
  if (params.installReqId) {
    result.installStatus = await broker.credentialInstallStatus(
      context.deviceId,
      params.installReqId
    )
  }
  if (params.resumeConfirmReqId) {
    if (context.transport.transport !== 'relay' || context.transport.credentialKind !== 'resume') {
      throw new Error('resume_confirmation_unavailable')
    }
    result.resumeConfirmation = await broker.confirmResume(
      context.transport.basisConnId,
      params.resumeConfirmReqId
    )
  }
  return result
}
