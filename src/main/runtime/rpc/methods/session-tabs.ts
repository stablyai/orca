import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import {
  ActivateTab,
  CreateTerminalTab,
  MoveTab,
  SaveMarkdownTab,
  SessionTabsUnsubscribe,
  SetTabProps,
  UpdatePaneLayout,
  WorktreeTabSelector
} from './session-tabs-schemas'

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
      runtime.activateMobileSessionTab(params.worktree, params.tabId, params.leafId)
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
        targetGroupId: params.targetGroupId,
        command: params.command,
        startupCommandDelivery: params.startupCommandDelivery,
        agent: params.agent,
        activate: params.activate
      })
  }),
  defineMethod({
    name: 'session.tabs.move',
    params: MoveTab,
    handler: async (params, { runtime }) => {
      const base = {
        tabId: params.tabId,
        targetGroupId: params.targetGroupId
      }
      if (params.kind === 'reorder') {
        return runtime.moveMobileSessionTab(params.worktree, {
          ...base,
          kind: 'reorder',
          tabOrder: params.tabOrder
        })
      }
      if (params.kind === 'split') {
        return runtime.moveMobileSessionTab(params.worktree, {
          ...base,
          kind: 'split',
          splitDirection: params.splitDirection
        })
      }
      return runtime.moveMobileSessionTab(params.worktree, {
        ...base,
        kind: 'move-to-group',
        index: params.index
      })
    }
  }),
  defineMethod({
    name: 'session.tabs.updatePaneLayout',
    params: UpdatePaneLayout,
    handler: async (params, { runtime }) =>
      runtime.updateMobileSessionPaneLayout(params.worktree, {
        tabId: params.tabId,
        root: params.root,
        expandedLeafId: params.expandedLeafId ?? null,
        titlesByLeafId: params.titlesByLeafId
      })
  }),
  defineMethod({
    name: 'session.tabs.setTabProps',
    params: SetTabProps,
    handler: async (params, { runtime }) =>
      runtime.setMobileSessionTabProps(params.worktree, {
        tabId: params.tabId,
        ...(params.color !== undefined ? { color: params.color } : {}),
        ...(params.isPinned !== undefined ? { isPinned: params.isPinned } : {})
      })
  }),
  defineStreamingMethod({
    name: 'session.tabs.subscribe',
    params: WorktreeTabSelector,
    handler: async (params, { runtime, connectionId, requestId }, emit) => {
      let subscribedWorktree: string | null = null
      let unsubscribe = (): void => {}
      let closed = false
      let initialized = false
      const initial = await runtime.listMobileSessionTabs(params.worktree)
      if (closed) {
        return
      }
      subscribedWorktree = initial.worktree
      const cleanupPrefix = `session.tabs:${connectionId ?? 'local'}:${subscribedWorktree}`
      const subscriptionId = requestId ? `${cleanupPrefix}:${requestId}` : cleanupPrefix
      // Why: shared-control can carry multiple subscribers for one worktree on
      // one socket; include the RPC id so one subscriber cannot evict another.
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
      emit({ type: 'snapshot', ...initial })
      initialized = true
      if (closed) {
        return
      }

      unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
        if (snapshot.worktree === subscribedWorktree) {
          emit({ type: 'updated', ...snapshot })
        }
      })
      if (closed) {
        unsubscribe()
      }
    }
  }),
  defineMethod({
    name: 'session.tabs.unsubscribe',
    params: SessionTabsUnsubscribe,
    handler: async (params, { runtime, connectionId }) => {
      const snapshot = await runtime.listMobileSessionTabs(params.worktree)
      const connection = connectionId ?? 'local'
      if (params.subscriptionId) {
        runtime.cleanupSubscription(
          `session.tabs:${connection}:${snapshot.worktree}:${params.subscriptionId}`
        )
        return { unsubscribed: true }
      }
      runtime.cleanupSubscription(`session.tabs:${connection}:${params.worktree}`)
      runtime.cleanupSubscription(`session.tabs:${connection}:${snapshot.worktree}`)
      runtime.cleanupSubscriptionsByPrefix(`session.tabs:${connection}:${snapshot.worktree}:`)
      return { unsubscribed: true }
    }
  }),
  defineStreamingMethod({
    name: 'session.tabs.subscribeAll',
    params: null,
    handler: async (_params, { runtime, connectionId, requestId }, emit) => {
      let unsubscribe = (): void => {}
      let closed = false
      // Why: initial listAll errors should return one RPC error, not a leaked
      // subscription cleanup that later emits a stray end frame.
      let initialized = false
      const cleanupPrefix = `session.tabs:${connectionId ?? 'local'}:*`
      const subscriptionId = requestId ? `${cleanupPrefix}:${requestId}` : cleanupPrefix
      // Why: shared-control can carry multiple all-tab subscribers on one
      // socket; include the RPC id so closing one does not evict siblings.
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
    name: 'session.tabs.unsubscribeAll',
    params: z
      .object({
        subscriptionId: z.string().min(1).optional()
      })
      .nullish(),
    handler: async (params, { runtime, connectionId }) => {
      const cleanupPrefix = `session.tabs:${connectionId ?? 'local'}:*`
      if (params?.subscriptionId) {
        runtime.cleanupSubscription(`${cleanupPrefix}:${params.subscriptionId}`)
        return { unsubscribed: true }
      }
      runtime.cleanupSubscription(cleanupPrefix)
      runtime.cleanupSubscriptionsByPrefix(`${cleanupPrefix}:`)
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
