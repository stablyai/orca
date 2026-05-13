import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'

const WorktreeTabSelector = z.object({
  worktree: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing worktree selector'))
})

const ActivateTab = WorktreeTabSelector.extend({
  tabId: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing tab id'))
})

const CreateTerminalTab = WorktreeTabSelector.extend({
  afterTabId: z.string().optional(),
  activate: z.boolean().optional()
})

const SaveMarkdownTab = ActivateTab.extend({
  baseVersion: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing base version')),
  content: z.string()
})

export const SESSION_TAB_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'session.tabs.list',
    params: WorktreeTabSelector,
    handler: async (params, { runtime }) => runtime.listMobileSessionTabs(params.worktree)
  }),
  defineMethod({
    name: 'session.tabs.activate',
    params: ActivateTab,
    handler: async (params, { runtime }) =>
      runtime.activateMobileSessionTab(params.worktree, params.tabId)
  }),
  defineMethod({
    name: 'session.tabs.close',
    params: ActivateTab,
    handler: async (params, { runtime }) =>
      runtime.closeMobileSessionTab(params.worktree, params.tabId)
  }),
  defineMethod({
    name: 'session.tabs.createTerminal',
    params: CreateTerminalTab,
    handler: async (params, { runtime }) =>
      runtime.createMobileSessionTerminal(params.worktree, {
        afterTabId: params.afterTabId,
        activate: params.activate
      })
  }),
  defineStreamingMethod({
    name: 'session.tabs.subscribe',
    params: WorktreeTabSelector,
    handler: async (params, { runtime, connectionId }, emit) => {
      let subscribedWorktree: string | null = null
      let unsubscribe = (): void => {}
      let closed = false
      const subscriptionId = `session.tabs:${connectionId ?? 'local'}:${params.worktree}`
      runtime.registerSubscriptionCleanup(
        subscriptionId,
        () => {
          closed = true
          unsubscribe()
          emit({ type: 'end' })
        },
        connectionId
      )
      const initial = await runtime.listMobileSessionTabs(params.worktree)
      if (closed) {
        return
      }
      subscribedWorktree = initial.worktree
      emit({ type: 'snapshot', ...initial })

      unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
        if (snapshot.worktree === subscribedWorktree) {
          emit({ type: 'updated', ...snapshot })
        }
      })
    }
  }),
  defineMethod({
    name: 'session.tabs.unsubscribe',
    params: WorktreeTabSelector,
    handler: async (params, { runtime, connectionId }) => {
      const snapshot = await runtime.listMobileSessionTabs(params.worktree)
      runtime.cleanupSubscription(`session.tabs:${connectionId ?? 'local'}:${params.worktree}`)
      runtime.cleanupSubscription(`session.tabs:${connectionId ?? 'local'}:${snapshot.worktree}`)
      return { unsubscribed: true }
    }
  }),
  defineMethod({
    name: 'markdown.readTab',
    params: ActivateTab,
    handler: async (params, { runtime }) =>
      runtime.readMobileMarkdownTab(params.worktree, params.tabId)
  }),
  defineMethod({
    name: 'markdown.saveTab',
    params: SaveMarkdownTab,
    handler: async (params, { runtime }) =>
      runtime.saveMobileMarkdownTab(
        params.worktree,
        params.tabId,
        params.baseVersion,
        params.content
      )
  })
]
