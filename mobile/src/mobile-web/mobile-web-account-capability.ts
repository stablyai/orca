import { executeMobileWebAccountOperation } from './mobile-web-account-operations'
import type { MobileWebCapabilityExecutionDependencies } from './mobile-web-capability-execution-dependencies'

export async function executeMobileWebAccountCapability(
  args: MobileWebCapabilityExecutionDependencies
): Promise<unknown> {
  return executeMobileWebAccountOperation({
    operation: args.request.operation,
    payload: args.request.payload,
    client: args.connectedClient(),
    nativeAuthority: args.nativeAuthority
  })
}
