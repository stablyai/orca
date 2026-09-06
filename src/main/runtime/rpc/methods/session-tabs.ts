import { z } from 'zod'
import { resolveRuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import {
  CreateTerminalTab,
  SessionTabsUnsubscribe,
  WorktreeTabSelector
} from './session-tabs-schemas'
import { SESSION_TAB_CLOSE_METHODS } from './session-tab-close-methods'
import {
  listSessionTabsInventory,
  projectSessionTabsForClient,
  subscribeSessionTabsInventory
} from './session-tabs-inventory'
import { SESSION_TAB_MARKDOWN_METHODS } from './session-tab-markdown-methods'
import { SESSION_TAB_MUTATION_METHODS } from './session-tab-mutation-methods'
import { restoreStructuredTabsIfSupported } from './structured-session-tab-restore'
import { isStructuredNativeChatEnabled } from './structured-agent-session-policy'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../../ai-vault/structured-session-ownership'

export const SESSION_TAB_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'session.tabs.list',
    params: WorktreeTabSelector,
    handler: async (params, { runtime, pairedDeviceId, clientKind, clientCapabilities }) => {
      await restoreStructuredTabsIfSupported({ runtime, clientKind, clientCapabilities })
      return projectSessionTabsForClient(
        await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId),
        clientKind,
        clientCapabilities,
        clientKind === 'mobile' ? isStructuredNativeChatEnabled(runtime) : undefined
      )
    }
  }),
  defineMethod({
    name: 'session.tabs.listAll',
    params: null,
    handler: async (_params, context) => {
      await restoreStructuredTabsIfSupported(context)
      return listSessionTabsInventory(context)
    }
  }),
  ...SESSION_TAB_MUTATION_METHODS,
  ...SESSION_TAB_CLOSE_METHODS,
  defineMethod({
    name: 'session.tabs.createTerminal',
    params: CreateTerminalTab,
    handler: async (params, { runtime, signal, clientKind, pairedDeviceId }) => {
      if (params.command) {
        await assertLegacyAiVaultResumeCommandAllowed(params.command, () =>
          runtime.ensureStructuredAgentSessionHost()
        )
      }
      return runtime.createMobileSessionTerminal(params.worktree, {
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
    }
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
      await restoreStructuredTabsIfSupported({ runtime, clientKind, clientCapabilities })
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
        ...projectSessionTabsForClient(
          initial,
          clientKind,
          clientCapabilities,
          clientKind === 'mobile' ? isStructuredNativeChatEnabled(runtime) : undefined
        )
      })
      initialized = true
      if (closed) {
        return
      }

      unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
        if (snapshot.worktree === subscribedWorktree) {
          emit({
            type: 'updated',
            ...projectSessionTabsForClient(
              snapshot,
              clientKind,
              clientCapabilities,
              clientKind === 'mobile' ? isStructuredNativeChatEnabled(runtime) : undefined
            )
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
    handler: async (_params, context, emit) => {
      await restoreStructuredTabsIfSupported(context)
      return subscribeSessionTabsInventory(context, emit)
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
