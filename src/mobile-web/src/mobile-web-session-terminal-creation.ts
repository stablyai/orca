import {
  MobileWebSessionAgentOptionsResultSchema,
  MobileWebSessionCreateResultSchema,
  type MobileWebSessionAgentOptionsPayload,
  type MobileWebSessionCreateAgentPayload,
  type MobileWebSessionCreatePayload
} from '../../shared/mobile-web/session-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { secureMobileWebBridgeRequestId } from './mobile-web-bridge-request-encoding'
import { requestMobileWebHost } from './mobile-web-host-request-client'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebSessionTerminalCreation {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  async agentOptions(payload: MobileWebSessionAgentOptionsPayload) {
    return MobileWebSessionAgentOptionsResultSchema.parse(
      await requestMobileWebHost(
        this.requests,
        'mobileWeb.session.agentOptions',
        payload.workspaceId,
        {}
      )
    )
  }

  create(payload: MobileWebSessionCreatePayload | MobileWebSessionCreateAgentPayload) {
    const timeoutMs = 15_000
    return (async () => {
      const result = await requestMobileWebHost(
        this.requests,
        'mobileWeb.session.createTerminal',
        payload.workspaceId,
        {
          ...('agent' in payload ? { agent: payload.agent } : {}),
          clientMutationId: secureMobileWebBridgeRequestId(),
          timeoutMs
        },
        { timeoutMs }
      )
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        throw new MobileWebBridgeClientError('invalid_message', false)
      }
      return MobileWebSessionCreateResultSchema.parse({
        ...result,
        workspaceId: payload.workspaceId
      })
    })()
  }
}
