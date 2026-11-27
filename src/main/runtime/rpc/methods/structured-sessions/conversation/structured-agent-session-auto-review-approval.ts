import type { AgentSessionAutoReviewApprovalResult } from '../../../../../../shared/agent-session/requests/approvals/agent-session-auto-review-approval'
import { AutoReviewApprovalParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-auto-review-params'
import { defineMethod } from '../../../core'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'

export const STRUCTURED_AGENT_SESSION_AUTO_REVIEW_METHODS = [
  defineMethod({
    name: 'agentSession.approveAutoReviewDenial',
    permission: 'workspace',
    params: AutoReviewApprovalParams,
    // Only a person may approve, so only this computer's own Orca window: the CLI, plugins and any
    // paired client (whose agent marker is self-declared) could be an agent authorizing itself.
    handler: async ({ sessionId, itemId }, ctx): Promise<AgentSessionAutoReviewApprovalResult> => {
      if (ctx.caller?.kind !== 'desktop' || ctx.plugin) {
        return { status: 'refused' }
      }
      const host = await requireInstalledStructuredHost(ctx, sessionId)
      return host.approveAutoReviewDenial(sessionId, itemId)
    }
  })
]
