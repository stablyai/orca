import { withSpan } from '../../../../observability/tracer'
import type { z } from 'zod'
import { callerTabPerson } from '../../../../bots/team-share/teammate-rules'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { SessionTabCloseTarget } from '../../../session-lifecycle/close/refuse-unattributed-mobile-session-tab-close'
import '../../../../../shared/remote-runtime/protocol/protocol-version'
import { SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/session-tabs-runtime-capabilities'
import { defineMethod, type RpcContext } from '../../core'
import {
  CloseLifecycleTab,
  CloseTab
} from '../../../../../shared/rpc-contract/session-tabs/session-tabs-schemas-params'
import { assertProjectedSessionTabVisible } from './session-tab-browser-placement-projection'
import { assertAgentSessionTabDestructiveMutationSupported } from './session-tab-agent-status-projection'
import { projectSessionTabsForClient } from './session-tabs-inventory'

/** The list a close names, the one resolver of its person: a watched list's (`params.person`, another
 *  person's, which moves no device of the closer's), else the caller's own on their device. Read once. */
async function sessionTabCloseTarget(
  params: z.infer<typeof CloseTab>,
  context: RpcContext
): Promise<SessionTabCloseTarget> {
  const { runtime } = context
  if (params.person) {
    const viewed = await runtime.listViewedSessionTabs(params.worktree, params.person, {
      includeAgentSenders: false
    })
    return {
      person: viewed.list === 'host' ? 'owner' : viewed.list,
      watched: true,
      list: async () => viewed.frame
    }
  }
  let own: Promise<RuntimeMobileSessionTabsResult> | undefined
  return {
    person: callerTabPerson(context.callerScope),
    ...(context.pairedDeviceId ? { clientNavigationId: context.pairedDeviceId } : {}),
    watched: false,
    list: () =>
      (own ??= runtime.listMobileSessionTabs(params.worktree, context.pairedDeviceId, {
        includeAgentSenders: false
      }))
  }
}

export const SESSION_TAB_CLOSE_METHODS = [
  defineMethod({
    name: 'session.tabs.close',
    permission: 'workspace',
    share: 'not-shared',
    params: CloseTab,
    handler: async (params, context) => {
      const closeTarget = await sessionTabCloseTarget(params, context)
      if (context.clientKind) {
        const raw = await closeTarget.list()
        const visible = projectSessionTabsForClient(
          raw,
          context.clientKind,
          context.clientCapabilities,
          context.runtime
        )
        assertProjectedSessionTabVisible(visible, params.tabId)
        assertAgentSessionTabDestructiveMutationSupported(
          raw,
          params.tabId,
          context.clientKind,
          context.clientCapabilities
        )
      }
      const requiresIntent =
        context.clientKind === undefined ||
        (context.clientKind === 'runtime' &&
          context.clientCapabilities?.includes(SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY) ===
            true)
      return withSpan(
        'runtime.session-tabs.close',
        async (span) => {
          // Preserve legacy runtime closes: user clicks and cleanup have identical wire shapes.
          if (!params.reason && requiresIntent) {
            const result = await context.runtime.refuseUnattributedMobileSessionTabClose(
              params.tabId,
              { ...closeTarget, person: closeTarget.person }
            )
            span.setAttribute('decision', `refused-${result.refusalReason ?? 'missing-intent'}`)
            return result
          }
          const result = await context.runtime.closeMobileSessionTab(
            params.worktree,
            params.tabId,
            {
              person: closeTarget.person,
              reason: 'user',
              // Only explicit reasons prove confirmation; legacy reasonless closes do not.
              ...(params.force && params.reason !== undefined ? { force: true } : {}),
              ...(closeTarget.clientNavigationId
                ? { clientNavigationId: closeTarget.clientNavigationId }
                : {})
            }
          )
          span.setAttribute(
            'decision',
            result.refused ? `refused-${result.refusalReason ?? 'unknown'}` : 'allowed'
          )
          return result
        },
        {
          kind: 'client',
          attributes: {
            attribution: 'session-tab-close',
            runtimeId: context.runtime.getRuntimeId(),
            origin: context.clientKind ?? 'in-process',
            deviceId: context.pairedDeviceId ?? 'in-process',
            worktree: params.worktree,
            tabId: params.tabId,
            closeReason:
              params.reason ??
              (requiresIntent
                ? 'missing'
                : context.clientKind === 'mobile'
                  ? 'legacy-mobile-user'
                  : 'legacy-runtime-user'),
            connectionGeneration: context.connectionId ?? 'in-process',
            requestId: context.requestId ?? 'in-process'
          }
        }
      )
    }
  }),
  defineMethod({
    name: 'session.tabs.closeLifecycle',
    permission: 'workspace',
    share: 'not-shared',
    params: CloseLifecycleTab,
    handler: async (params, context) => {
      if (context.clientKind) {
        const raw = await context.runtime.listMobileSessionTabs(
          params.worktree,
          context.pairedDeviceId,
          { includeAgentSenders: false }
        )
        const visible = projectSessionTabsForClient(
          raw,
          context.clientKind,
          context.clientCapabilities,
          context.runtime
        )
        assertProjectedSessionTabVisible(visible, params.tabId)
        assertAgentSessionTabDestructiveMutationSupported(
          raw,
          params.tabId,
          context.clientKind,
          context.clientCapabilities
        )
      }
      return withSpan(
        'runtime.session-tabs.close-lifecycle',
        async (span) => {
          const result = await context.runtime.closeMobileSessionTab(
            params.worktree,
            params.tabId,
            {
              person: callerTabPerson(context.callerScope),
              reason: params.reason,
              expectedPublicationEpoch: params.publicationEpoch,
              expectedTerminalHandle: params.terminal,
              ...(context.pairedDeviceId ? { clientNavigationId: context.pairedDeviceId } : {})
            }
          )
          span.setAttribute(
            'decision',
            result.refused ? `refused-${result.refusalReason ?? 'unknown'}` : 'allowed'
          )
          return result
        },
        {
          kind: 'client',
          attributes: {
            attribution: 'session-tab-lifecycle-close',
            runtimeId: context.runtime.getRuntimeId(),
            origin: context.clientKind ?? 'in-process',
            deviceId: context.pairedDeviceId ?? 'in-process',
            worktree: params.worktree,
            tabId: params.tabId,
            terminal: params.terminal,
            closeReason: params.reason,
            connectionGeneration: context.connectionId ?? 'in-process',
            requestId: context.requestId ?? 'in-process',
            publicationEpoch: params.publicationEpoch
          }
        }
      )
    }
  })
]
