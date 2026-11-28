// `agentSession.setBadge` — another program pins a small picture on a chat (or clears it). The host
// saves it on the chat's record, and the chat's naming note carries it to every client's sidebar.

import { defineMethod } from '../../../core'
import { requireRenameStructuredHost } from '../creation/structured-agent-session-gate'
import '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import { SetBadgeParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-badge-params'
import { readAgentSessionBadge } from '../../../../../../shared/agent-session/conversation-naming/agent-session-badge'

export const STRUCTURED_AGENT_SESSION_SET_BADGE_METHODS = [
  defineMethod({
    name: 'agentSession.setBadge',
    permission: 'workspace',
    params: SetBadgeParams,
    handler: async (params, ctx) => {
      const badge = params.badge === null ? null : readAgentSessionBadge(params.badge)
      if (badge === undefined) {
        throw new Error('agent_session_badge_invalid')
      }
      // Badging reads no journal, so it shares the rename gate the paired CLI is allowed through.
      const host = await requireRenameStructuredHost(ctx, params.sessionId)
      const { store } = host.deps
      if (!store.getRecord(params.sessionId)) {
        throw new Error('agent_session_identity_required')
      }
      const record = await store.updateRecord(params.sessionId, {
        kind: 'badge',
        badge,
        now: Date.now()
      })
      // The naming note carries the badge, so every client's sidebar redraws the row.
      host.publishConversationName(params.sessionId)
      return { badge: record.badge ?? null }
    }
  })
]
