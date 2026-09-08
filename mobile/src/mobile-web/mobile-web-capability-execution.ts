import type { MobileWebBridgePageMessage } from '../../../src/shared/mobile-web/bridge-contract'
import type { MobileWebBridgeCapability } from '../../../src/shared/mobile-web/bridge-operation-registry'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebCapabilityExecutionDependencies } from './mobile-web-capability-execution-dependencies'
import {
  MOBILE_WEB_ONCE_CAPABILITY_ARMS,
  MOBILE_WEB_SUBSCRIPTION_CAPABILITY_ARMS
} from './mobile-web-capability-execution-arms'

type PageRequest = Extract<MobileWebBridgePageMessage, { type: 'request' }>

export async function executeMobileWebCapabilityRequest(
  args: MobileWebCapabilityExecutionDependencies
): Promise<unknown> {
  const request: PageRequest = args.request
  const capability: MobileWebBridgeCapability = request.capability
  if (request.mode === 'subscription') {
    const arm = MOBILE_WEB_SUBSCRIPTION_CAPABILITY_ARMS[capability]
    if (!arm) {
      throw new MobileWebBrokerError('unsupported_capability')
    }
    return arm(args, request)
  }
  const arm = MOBILE_WEB_ONCE_CAPABILITY_ARMS[capability]
  if (!arm) {
    throw new MobileWebBrokerError('unsupported_capability')
  }
  return arm(args, request)
}
