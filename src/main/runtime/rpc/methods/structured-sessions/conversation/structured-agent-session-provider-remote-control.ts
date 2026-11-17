import { ProviderRemoteControlParams } from '../../../../../../shared/rpc-contract/structured-agent-session/provider-remote-control-params'
import { defineMethod } from '../../../core'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'

export const STRUCTURED_AGENT_SESSION_PROVIDER_REMOTE_CONTROL_METHODS = [
  defineMethod({
    name: 'agentSession.providerRemoteControl',
    permission: 'workspace',
    params: ProviderRemoteControlParams,
    handler: async ({ sessionId, choice }, ctx) => {
      const host = await requireInstalledStructuredHost(ctx, sessionId)
      return host.reads.providerRemoteControl(sessionId, choice)
    }
  })
]
