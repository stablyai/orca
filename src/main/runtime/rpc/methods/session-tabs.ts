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
  command: z.string().optional(),
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
    name: 'session.tabs.listAll',
    params: null,
    handler: async (_params, { runtime }) => ({
      snapshots: await runtime.listAllMobileSessionTabs()
    })
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
        command: params.command,
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
      // Why: initial list errors should return one RPC error, not a leaked
      // subscription cleanup that later emits a stray end frame.
      let initialized = false
      const subscriptionId = `session.tabs:${connectionId ?? 'local'}:${params.worktree}`
      runtime.registerSubscriptionCleanup(
        subscriptionId,
        () => {
          closed = true
          unsubscribe()
          if (initialized) {
            emit({ type: 'end' })
          }
        },
        connectionId
      )
      const initial = await Promise.resolve(runtime.listMobileSessionTabs(params.worktree)).catch(
        (error) => {
          runtime.cleanupSubscription(subscriptionId)
          throw error
        }
      )
      if (closed) {
        return
      }
      subscribedWorktree = initial.worktree
      emit({ type: 'snapshot', ...initial })
      initialized = true

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
  defineStreamingMethod({
    name: 'session.tabs.subscribeAll',
    params: null,
    handler: async (_params, { runtime, connectionId }, emit) => {
      let unsubscribe = (): void => {}
      let closed = false
      // Why: initial listAll errors should return one RPC error, not a leaked
      // subscription cleanup that later emits a stray end frame.
      let initialized = false
      const subscriptionId = `session.tabs:${connectionId ?? 'local'}:*`
      runtime.registerSubscriptionCleanup(
        subscriptionId,
        () => {
          closed = true
          unsubscribe()
          if (initialized) {
            emit({ type: 'end' })
          }
        },
        connectionId
      )

      if (closed) {
        return
      }
      const snapshots = await Promise.resolve(runtime.listAllMobileSessionTabs()).catch((error) => {
        runtime.cleanupSubscription(subscriptionId)
        throw error
      })
      if (closed) {
        return
      }
      emit({ type: 'snapshots', snapshots })
      initialized = true

      if (closed) {
        return
      }
      unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
        emit({ type: 'updated', ...snapshot })
      })
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
