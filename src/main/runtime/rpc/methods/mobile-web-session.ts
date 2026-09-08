import { z } from 'zod'
import { defineMethod } from '../core'
import {
  MobileWebSessionScope,
  mobileWebSessionMethod,
  projectMobileWebSession
} from './mobile-web-session-scope'

const list = mobileWebSessionMethod('session.tabs.list')
const activate = mobileWebSessionMethod('session.tabs.activate')
const close = mobileWebSessionMethod('session.tabs.close')
const Action = MobileWebSessionScope.extend({ tabId: z.string().min(1).max(512) })
const Close = z.object({
  closed: z.literal(true),
  refused: z.boolean().optional(),
  refusalReason: z
    .enum([
      'missing-intent',
      'stale-publication',
      'stale-terminal',
      'live-host-pty',
      'unknown-liveness',
      'retirement-owner'
    ])
    .optional()
})

export const MOBILE_WEB_SESSION_METHODS = [
  defineMethod({
    name: 'mobileWeb.session.snapshot',
    params: MobileWebSessionScope,
    handler: async (params, context) =>
      projectMobileWebSession(
        await list.handler(list.params!.parse({ worktree: params.worktree }), context),
        params,
        context
      )
  }),
  defineMethod({
    name: 'mobileWeb.session.activate',
    params: Action,
    handler: async (params, context) => {
      if (context.signal?.aborted) {
        throw new Error('runtime_unavailable')
      }
      return projectMobileWebSession(
        await activate.handler(
          activate.params!.parse({
            worktree: params.worktree,
            tabId: params.tabId,
            notifyClients: false,
            navigation: 'caller'
          }),
          context
        ),
        params,
        context
      )
    }
  }),
  defineMethod({
    name: 'mobileWeb.session.close',
    params: Action,
    handler: async (params, context) => {
      if (context.signal?.aborted) {
        throw new Error('runtime_unavailable')
      }
      const result = Close.parse(
        await close.handler(
          close.params!.parse({ worktree: params.worktree, tabId: params.tabId, reason: 'user' }),
          context
        )
      )
      if (result.refused && !result.refusalReason) {
        throw new Error('runtime_unavailable')
      }
      return {
        workspaceId: params.workspaceId,
        tabId: params.tabId,
        outcome: result.refused ? 'refused' : 'closed',
        refusalReason: result.refused ? result.refusalReason : null
      }
    }
  })
]
