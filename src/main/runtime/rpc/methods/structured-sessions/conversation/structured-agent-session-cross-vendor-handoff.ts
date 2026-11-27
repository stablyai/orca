import { CrossVendorHandoffParams } from '../../../../../../shared/rpc-contract/structured-agent-session/cross-vendor-handoff-params'
import { defineMethod } from '../../../core'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'
import { runCrossVendorHandoff } from '../../../../../native-chat/agent-session-wire/cross-vendor/cross-vendor-handoff'
import { getCrossVendorHandoffSeeds } from '../../../../../native-chat/agent-session-wire/cross-vendor/cross-vendor-handoff-seeds'

export const STRUCTURED_AGENT_SESSION_CROSS_VENDOR_HANDOFF_METHODS = [
  defineMethod({
    name: 'agentSession.crossVendorHandoff',
    permission: 'workspace',
    params: CrossVendorHandoffParams,
    handler: async (params, ctx) => {
      const host = await requireInstalledStructuredHost(ctx, params.sessionId)
      // The source is read through the same host; its own audience gate applies too.
      await requireInstalledStructuredHost(ctx, params.sourceSessionId, true)
      const seeds = getCrossVendorHandoffSeeds()
      if (!seeds) {
        throw new Error('structured_agent_session_unsupported')
      }
      return runCrossVendorHandoff(host, seeds, params)
    }
  })
]
