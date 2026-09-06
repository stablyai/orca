import {
  MobileWebAgentHistoryPreviewPayloadSchema,
  MobileWebAgentHistoryResumePayloadSchema,
  MobileWebAgentHistoryResumeResultSchema
} from '../../../src/shared/mobile-web/agent-history-operation-contract'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebCapabilityExecutionDependencies } from './mobile-web-capability-execution-dependencies'
import { mobileWebAgentHistoryPreview } from './mobile-web-agent-history-presentation'

export async function executeMobileWebAgentHistoryOperation(
  args: MobileWebCapabilityExecutionDependencies
): Promise<unknown> {
  const request = args.request
  if (request.operation === 'snapshot') {
    return args.agentHistoryPager.page(
      request.payload,
      args.connectedClient(),
      args.workspaceAuthority,
      args.agentHistoryAuthority
    )
  }
  if (request.operation === 'preview') {
    const payload = MobileWebAgentHistoryPreviewPayloadSchema.parse(request.payload)
    return mobileWebAgentHistoryPreview(
      args.agentHistoryAuthority.hostSession(payload.sessionHandle)
    )
  }
  if (request.operation === 'resume') {
    const payload = MobileWebAgentHistoryResumePayloadSchema.parse(request.payload)
    const result = await args.agentHistoryResume.resume({
      payload,
      client: args.connectedClient(),
      agentHistoryAuthority: args.agentHistoryAuthority,
      workspaceAuthority: args.workspaceAuthority
    })
    return MobileWebAgentHistoryResumeResultSchema.parse(result)
  }
  throw new MobileWebBrokerError('unsupported_capability')
}
