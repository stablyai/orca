import { z } from 'zod'
import { resolveRuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import {
  CreateTerminalTab,
  SessionTabsUnsubscribe,
  WorktreeTabSelector
} from './session-tabs-schemas'
import { SESSION_TAB_CLOSE_METHODS } from './session-tab-close-methods'
import { projectSessionTabAgentStatus } from './session-tab-agent-status-projection'
import { projectSessionTabBrowserPlacements } from './session-tab-browser-placement-projection'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { SESSION_TAB_MARKDOWN_METHODS } from './session-tab-markdown-methods'
import { SESSION_TAB_MUTATION_METHODS } from './session-tab-mutation-methods'

function projectSessionTabsForClient(
  snapshot: RuntimeMobileSessionTabsResult,
  clientKind: 'mobile' | 'runtime' | undefined,
  clientCapabilities: Parameters<typeof projectSessionTabAgentStatus>[2]
) {
  return projectSessionTabBrowserPlacements(
    projectSessionTabAgentStatus(snapshot, clientKind, clientCapabilities),
    clientCapabilities
  )
}

export const SESSION_TAB_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'session.tabs.list',
    params: WorktreeTabSelector,
    handler: async (params, { runtime, pairedDeviceId, clientKind, clientCapabilities }) =>
      projectSessionTabsForClient(
        await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId),
        clientKind,
        clientCapabilities
      )
  }),
  defineMethod({
    name: 'session.tabs.listAll',
    params: null,
    handler: async (_params, { runtime, pairedDeviceId, clientKind, clientCapabilities }) => ({
      snapshots: (await runtime.listAllMobileSessionTabs(pairedDeviceId)).map((snapshot) =>
        projectSessionTabsForClient(snapshot, clientKind, clientCapabilities)
      )
    })
  }),
  ...SESSION_TAB_MUTATION_METHODS,
  ...SESSION_TAB_CLOSE_METHODS,
  defineMethod({
    name: 'session.tabs.createTerminal',
    params: CreateTerminalTab,
    handler: async (params, { runtime, signal, clientKind, pairedDeviceId }) =>
      runtime.createMobileSessionTerminal(params.worktree, {
        afterTabId: params.afterTabId,
        targetGroupId: params.targetGroupId,
        command: params.command,
        cwd: params.cwd,
        ...(params.env ? { env: params.env } : {}),
        ...(params.envToDelete ? { envToDelete: params.envToDelete } : {}),
        startupCommandDelivery: params.startupCommandDelivery,
        agent: params.agent,
        ...(params.agentPrompt !== undefined ? { agentPrompt: params.agentPrompt } : {}),
        ...(params.launchConfig ? { launchConfig: params.launchConfig } : {}),
        ...(params.launchToken ? { launchToken: params.launchToken } : {}),
        ...(params.launchAgent ? { launchAgent: params.launchAgent } : {}),
        ...(params.viewMode ? { viewMode: params.viewMode } : {}),
        activate: params.activate,
        select: params.select,
        clientNavigationId: pairedDeviceId,
        navigation: resolveRuntimeNavigationTarget({
          navigation: params.navigation,
          clientKind
        }),
        clientMutationId: params.clientMutationId,
        // Why: a dead client connection must cancel the surface wait instead
        // of running down the timeout and rolling back a live tab (#7718).
        signal
      })
  }),
  defineStreamingMethod({
    name: 'session.tabs.subscribe',
    params: WorktreeTabSelector,
    handler: async (
      params,
      { runtime, connectionId, requestId, pairedDeviceId, clientKind, clientCapabilities },
      emit
    ) => {
      let subscribedWorktree: string | null = null
      let unsubscribe = (): void => {}
      let closed = false
      let initialized = false
      const initial = await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId)
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
      emit({
        type: 'snapshot',
        ...projectSessionTabsForClient(initial, clientKind, clientCapabilities)
      })
      initialized = true
      if (closed) {
        return
      }

      unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
        if (snapshot.worktree === subscribedWorktree) {
          emit({
            type: 'updated',
            ...projectSessionTabsForClient(snapshot, clientKind, clientCapabilities)
          })
        }
      }, pairedDeviceId)
      if (closed) {
        unsubscribe()
      }
    }
  }),
  defineMethod({
    name: 'session.tabs.unsubscribe',
    params: SessionTabsUnsubscribe,
    handler: async (params, { runtime, connectionId, pairedDeviceId }) => {
      const snapshot = await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId)
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
    handler: async (
      _params,
      { runtime, connectionId, requestId, pairedDeviceId, clientKind, clientCapabilities },
      emit
    ) => {
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
      const snapshots = await Promise.resolve(
        runtime.listAllMobileSessionTabs(pairedDeviceId)
      ).catch((error) => {
        runtime.cleanupSubscription(subscriptionId)
        throw error
      })
      if (closed) {
        return
      }
      emit({
        type: 'snapshots',
        snapshots: snapshots.map((snapshot) =>
          projectSessionTabsForClient(snapshot, clientKind, clientCapabilities)
        )
      })
      initialized = true

      if (closed) {
        return
      }
      unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
        emit({
          type: 'updated',
          ...projectSessionTabsForClient(snapshot, clientKind, clientCapabilities)
        })
      }, pairedDeviceId)
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
  ...SESSION_TAB_MARKDOWN_METHODS
]
