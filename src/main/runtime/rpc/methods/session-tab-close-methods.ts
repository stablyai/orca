import { withSpan } from '../../../observability/tracer'
import { defineMethod, type RpcAnyMethod } from '../core'
import { CloseLifecycleTab, CloseTab } from './session-tabs-schemas'

export const SESSION_TAB_CLOSE_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'session.tabs.close',
    params: CloseTab,
    handler: async (params, context) =>
      withSpan(
        'runtime.session-tabs.close',
        async (span) => {
          if (!params.reason && context.clientKind === undefined) {
            const result = await context.runtime.refuseUnattributedMobileSessionTabClose(
              params.worktree,
              params.tabId
            )
            span.setAttribute('decision', `refused-${result.refusalReason ?? 'missing-intent'}`)
            return result
          }
          const result = await context.runtime.closeMobileSessionTab(
            params.worktree,
            params.tabId,
            { reason: 'user' }
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
            origin: context.clientKind ?? 'in-process',
            closeReason:
              params.reason ??
              (context.clientKind ? `legacy-${context.clientKind}-user` : 'missing'),
            connectionGeneration: context.connectionId ?? 'in-process',
            requestId: context.requestId ?? 'in-process'
          }
        }
      )
  }),
  defineMethod({
    name: 'session.tabs.closeLifecycle',
    params: CloseLifecycleTab,
    handler: async (params, context) =>
      withSpan(
        'runtime.session-tabs.close-lifecycle',
        async (span) => {
          const result = await context.runtime.closeMobileSessionTab(
            params.worktree,
            params.tabId,
            {
              reason: params.reason,
              expectedPublicationEpoch: params.publicationEpoch,
              expectedTerminalHandle: params.terminal
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
            origin: context.clientKind ?? 'in-process',
            closeReason: params.reason,
            connectionGeneration: context.connectionId ?? 'in-process',
            requestId: context.requestId ?? 'in-process',
            publicationEpoch: params.publicationEpoch
          }
        }
      )
  })
]
