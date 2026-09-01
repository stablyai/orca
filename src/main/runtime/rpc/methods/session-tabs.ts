import { z } from 'zod'
import { resolveRuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import {
  ActivateTab,
  CreateTerminalTab,
  DismissLaunchNotice,
  MoveTab,
  SaveMarkdownTab,
  SessionTabsUnsubscribe,
  SetTabProps,
  UpdatePaneLayout,
  WorktreeTabSelector
} from './session-tabs-schemas'
import { SESSION_TAB_CLOSE_METHODS } from './session-tab-close-methods'
import { SESSION_TABS_SUBSCRIBE_METHOD } from './session-tabs-subscribe-method'
import { projectSessionTabAgentStatus } from './session-tab-agent-status-projection'

export const SESSION_TAB_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'session.tabs.list',
    params: WorktreeTabSelector,
    handler: async (params, { runtime, pairedDeviceId, clientKind, clientCapabilities }) =>
      projectSessionTabAgentStatus(
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
        projectSessionTabAgentStatus(snapshot, clientKind, clientCapabilities)
      )
    })
  }),
  defineMethod({
    name: 'session.tabs.activate',
    params: ActivateTab,
    handler: async (params, { runtime, clientKind, pairedDeviceId }) =>
      runtime.activateMobileSessionTab(params.worktree, params.tabId, params.leafId, {
        notifyClients: params.notifyClients !== false,
        clientNavigationId: pairedDeviceId,
        ...(params.intent ? { intent: params.intent } : {}),
        navigation: resolveRuntimeNavigationTarget({
          navigation: params.navigation,
          notifyClients: params.notifyClients,
          clientKind
        })
      })
  }),
  ...SESSION_TAB_CLOSE_METHODS,
  defineMethod({
    name: 'session.tabs.createTerminal',
    params: CreateTerminalTab,
    handler: async (params, { runtime, clientKind, signal, pairedDeviceId }) => {
      const baseOpts = {
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
        // Authenticated RPC scope for host-resolved launches; never client JSON.
        // The paired device narrows the admission principal to this device.
        clientKind,
        ...(pairedDeviceId ? { deviceId: pairedDeviceId } : {}),
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
      }
      // A pre-spawn typed failure returns the failure arm as an RPC success.
      if (params.agentLaunch) {
        return runtime.createMobileSessionTerminal(params.worktree, {
          ...baseOpts,
          agentLaunch: params.agentLaunch
        })
      }
      return runtime.createMobileSessionTerminal(params.worktree, baseOpts)
    }
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
        ...(params.isPinned !== undefined ? { isPinned: params.isPinned } : {}),
        ...(params.viewMode !== undefined ? { viewMode: params.viewMode } : {})
      })
  }),
  defineMethod({
    // Authenticated transport gates client access; the token + terminal + enum
    // code are the per-terminal authorization. A non-enum code was already
    // rejected by the schema, so this fails closed on a foreign/stale token.
    name: 'session.tabs.dismissLaunchNotice',
    params: DismissLaunchNotice,
    handler: async (params, { runtime }) =>
      runtime.dismissLaunchNotice(params.worktree, {
        tabId: params.tabId,
        launchToken: params.launchToken,
        code: params.code
      })
  }),
  SESSION_TABS_SUBSCRIBE_METHOD,
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
          projectSessionTabAgentStatus(snapshot, clientKind, clientCapabilities)
        )
      })
      initialized = true

      if (closed) {
        return
      }
      unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
        emit({
          type: 'updated',
          ...projectSessionTabAgentStatus(snapshot, clientKind, clientCapabilities)
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
