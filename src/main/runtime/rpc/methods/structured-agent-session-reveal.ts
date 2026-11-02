import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { StructuredWorkspaceUnavailable } from '../../session-tabs/structured-workspace-authority'
// Republish an existing host-owned record's tab for history entries holding only session id; unpublished tabs disappear on sync.
// Unlike ensure, read workspace/provider from host state so callers cannot redirect publication.

import {
  agentSessionRefusalFromReference,
  isAgentSessionRefusalError,
  isAgentSessionWireRefusalCode
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { StructuredAgentSessionReveal } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import { refuseAgentSessionMutation } from '../../../native-chat/agent-session-wire/structured-agent-session-mutation-admission'
import { defineMethod } from '../core'
import {
  ensureStructuredHostInstalled,
  requireStructuredCapability,
  requireStructuredAgentAudience,
  requireStructuredHost
} from './structured-agent-session-gate'
import {
  structuredSessionSurfaceIsCurrent,
  type StructuredSessionSurface
} from '../../agent-session/structured-agent-session-close'
import { RevealParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_REVEAL_METHODS = [
  defineMethod({
    name: 'agentSession.reveal',
    permission: 'workspace',
    params: RevealParams,
    handler: async (params, ctx) => {
      const caller = params.navigation === 'caller' ? ctx.caller : undefined
      if (params.navigation === 'caller' && caller?.kind !== 'paired-device') {
        throw new Error('forbidden')
      }
      requireStructuredCapability(ctx)
      await ensureStructuredHostInstalled(ctx)
      let publication: StructuredSessionSurface | null = null
      let revealed: StructuredAgentSessionReveal
      try {
        const host = requireStructuredHost(ctx)
        requireStructuredAgentAudience(ctx, host.sessionAgent(params.sessionId) ?? '')
        revealed = await host.revealSession(params.sessionId)
      } catch (error) {
        // Translate only typed host refusal codes; genuine faults must not masquerade as missing chats.
        const code = error instanceof Error ? error.message : ''
        if (!isAgentSessionWireRefusalCode(code)) {
          throw error
        }
        return refuseAgentSessionMutation(
          agentSessionRefusalFromReference(
            isAgentSessionRefusalError(error) ? error.refusal : { code },
            code === 'structured_agent_session_unsupported'
              ? 'This host cannot open that chat.'
              : 'This chat is no longer on this host.'
          )
        )
      }
      let workspace:
        | Awaited<ReturnType<typeof ctx.runtime.prepareStructuredAgentSessionRevealWorkspace>>
        | undefined
      let effects = false
      let saving = Promise.resolve()
      try {
        const host = requireStructuredHost(ctx)
        const record = host.deps.store.getConversation(revealed.sessionId)
        if (
          !record ||
          record.location.workspaceId !== revealed.workspaceId ||
          record.provider !== revealed.agent
        ) {
          throw new StructuredWorkspaceUnavailable('obsolete')
        }
        workspace = await ctx.runtime.prepareStructuredAgentSessionRevealWorkspace(record.location)
        const location = JSON.stringify(record.location)
        const current = () => {
          const now = host.deps.store.getConversation(revealed.sessionId)
          return (
            workspace!.current() &&
            getStructuredAgentSessionHost() === host &&
            now?.provider === record.provider &&
            JSON.stringify(now?.location) === location
          )
        }
        const check = () => {
          workspace!.check()
          if (!current()) {
            throw new StructuredWorkspaceUnavailable('obsolete')
          }
        }
        await ctx.runtime.publishStructuredAgentSessionTab({
          workspaceAuthority: {
            check,
            current,
            committed: () => {
              effects = true
            },
            saving: (work) => {
              saving = work
            }
          },
          workspaceId: revealed.workspaceId,
          sessionId: revealed.sessionId,
          agent: revealed.agent,
          capture: (surface) => {
            publication = surface
          },
          activate: params.navigation !== 'caller',
          ...(params.navigation ? { navigation: params.navigation } : {})
        })
        check()
        if (
          !structuredSessionSurfaceIsCurrent(
            requireStructuredHost(ctx),
            revealed.sessionId,
            publication,
            ctx.runtime
          )
        ) {
          throw new Error('Chat tab publication was superseded')
        }
        if (
          caller?.kind === 'paired-device' &&
          !ctx.runtime.reopenMobileSessionTabForClient(
            revealed.workspaceId,
            revealed.sessionId,
            caller.deviceId
          )
        ) {
          throw new Error('Could not publish the chat to its caller.')
        }
        check()
        // Return named fields only; private journal-open reasons stay on the host.
        const { sessionId, workspaceId, agent, readable } = revealed
        return { ok: true as const, sessionId, workspaceId, agent, readable }
      } catch (error) {
        if (!(error instanceof StructuredWorkspaceUnavailable)) {
          throw error
        }
        return {
          ok: false as const,
          refusal: {
            code:
              error.reason === 'removed' && !effects
                ? 'agent_session_workspace_removed'
                : 'agent_session_operation_unknown',
            message:
              error.reason === 'removed'
                ? 'This workspace is no longer available.'
                : 'The structured agent session is not available yet. Retry in a moment.'
          }
        }
      } finally {
        const owned = workspace
        void saving.finally(() => owned?.release())
      }
    }
  })
]
