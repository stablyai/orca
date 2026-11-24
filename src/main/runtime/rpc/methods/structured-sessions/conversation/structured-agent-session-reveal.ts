import { assertBotLinkOpenAuthority } from '../../../../../bots/bot-link-open-authority'
import { holdAgentSessionPublicationFence } from '../../../../agent-session/agent-session-publication-fence'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { StructuredWorkspaceUnavailable } from '../../../../session-tabs/chat/structured-workspace-authority'
import type { StructuredSessionWorkspaceRemovedDetails } from '../../../../../../shared/agent-session/view/open-structured-agent-session'
// Republish an existing host-owned record's tab for history entries holding only session id; unpublished tabs disappear on sync.
// Unlike ensure, read workspace/provider from host state so callers cannot redirect publication.

import {
  agentSessionRefusalFromReference,
  isAgentSessionRefusalError,
  isAgentSessionWireRefusalCode
} from '../../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { StructuredAgentSessionReveal } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import '../../../../../native-chat/agent-session-wire/operations/structured-agent-session-mutation-admission'
import { refuseAgentSessionMutation } from '../../../../../native-chat/agent-session-wire/operations/structured-agent-session-mutation-refusals'
import { defineMethod } from '../../../core'
import {
  ensureStructuredHostInstalled,
  requireStructuredCapability,
  requireStructuredAgentAudience,
  requireStructuredHost
} from '../creation/structured-agent-session-gate'
import {
  structuredSessionSurfaceIsCurrent,
  type StructuredSessionSurface
} from '../../../../agent-session/lifecycle/structured-agent-session-close'
import { RevealParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-continue-params'
import '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-rename-params'
import '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-queued-edit-params'

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
      if (params.botLinkTarget) {
        if (params.navigation !== 'caller') {
          throw new Error('forbidden')
        }
        assertBotLinkOpenAuthority(ctx.runtime, params.botLinkTarget, {
          sessionId: params.sessionId,
          worktreeId: params.botLinkTarget.worktreeId
        })
      }
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
      const publicationFence = params.botLinkTarget
        ? holdAgentSessionPublicationFence([
            JSON.stringify(['bot', params.botLinkTarget.botId]),
            JSON.stringify([
              'conversation',
              params.botLinkTarget.conversation.source,
              params.botLinkTarget.conversation.externalId
            ]),
            ...(params.botLinkTarget.workerDispatchId
              ? [JSON.stringify(['worker', params.botLinkTarget.workerDispatchId])]
              : [])
          ])
        : undefined
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
          if (params.botLinkTarget) {
            assertBotLinkOpenAuthority(ctx.runtime, params.botLinkTarget, {
              sessionId: revealed.sessionId,
              worktreeId: revealed.workspaceId
            })
          }
          workspace!.check()
          if (!current()) {
            throw new StructuredWorkspaceUnavailable('obsolete')
          }
        }
        await ctx.runtime.publishStructuredAgentSessionTab({
          workspaceAuthority: {
            writerFence: publicationFence?.fence,
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
          // Host navigation moves the window after publication; publication itself knows only the caller's.
          ...(params.navigation === 'caller' ? { navigation: params.navigation } : {})
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
          !(await ctx.runtime.reopenMobileSessionTabForClient(
            revealed.workspaceId,
            revealed.sessionId,
            caller.deviceId
          ))
        ) {
          throw new Error('Could not publish the chat to its caller.')
        }
        check()
        if (params.navigation === 'host') {
          ctx.runtime.focusChatInHostWindow(revealed.workspaceId, revealed.sessionId)
        }
        // A bot thread is no longer new once opened anywhere.
        for (const id of new Set([params.sessionId, revealed.sessionId])) {
          ctx.runtime.markBotThreadSeen(id)
        }
        // Return named fields only; private journal-open reasons stay on the host.
        const { sessionId, workspaceId, agent, readable } = revealed
        return { ok: true as const, sessionId, workspaceId, agent, readable }
      } catch (error) {
        if (!effects && !(error instanceof StructuredWorkspaceUnavailable)) {
          throw error
        }
        const removed =
          error instanceof StructuredWorkspaceUnavailable && error.reason === 'removed'
        return {
          ok: false as const,
          refusal: {
            code:
              removed && !effects
                ? 'agent_session_workspace_removed'
                : 'agent_session_operation_unknown',
            message: removed
              ? 'This workspace is no longer available.'
              : "Couldn't open this chat.",
            ...(removed && !effects && error.workspaceKind
              ? {
                  details: {
                    workspaceKind: error.workspaceKind
                  } satisfies StructuredSessionWorkspaceRemovedDetails
                }
              : {})
          }
        }
      } finally {
        publicationFence?.release()
        const owned = workspace
        void saving.finally(() => owned?.release())
      }
    }
  })
]
