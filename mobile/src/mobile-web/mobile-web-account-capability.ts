import { MobileWebAccountSubscribePayloadSchema } from '../../../src/shared/mobile-web/account-operation-contract'
import { executeMobileWebAccountOperation } from './mobile-web-account-operations'
import type { MobileWebCapabilityExecutionDependencies } from './mobile-web-capability-execution-dependencies'

export async function executeMobileWebAccountCapability(
  args: MobileWebCapabilityExecutionDependencies
): Promise<unknown> {
  const { request } = args
  if (request.mode === 'subscription' && request.operation === 'subscribe') {
    MobileWebAccountSubscribePayloadSchema.parse(request.payload)
    args.accountSubscriptions.start({
      requestId: request.requestId,
      subscriptionId: request.subscriptionId,
      client: args.connectedClient()
    })
    return null
  }
  if (request.mode === 'once') {
    return executeMobileWebAccountOperation({
      operation: request.operation,
      payload: request.payload,
      client: args.connectedClient(),
      nativeAuthority: args.nativeAuthority
    })
  }
  throw new Error('unsupported_account_request')
}
