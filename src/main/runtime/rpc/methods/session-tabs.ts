import { resolveRuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { getExplicitWorktreeIdSelector } from '../../runtime-worktree-selection'
import { defineMethod, defineStreamingMethod } from '../core'
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
import { createSessionTabsRetirementProofDelta } from './session-tabs-retirement-proof-delta'
import { restoreStructuredTabsIfSupported } from './structured-session-tab-restore'
import { isStructuredNativeChatEnabled } from './structured-agent-session-policy'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../../ai-vault/structured-session-ownership'
import { SessionTabsUnsubscribeAllParams } from '../../../../shared/rpc-contract/session-tabs-params'
import { SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

export const SESSION_TAB_METHODS = [
  defineMethod({
    name: 'session.tabs.list',
    params: WorktreeTabSelector,
    handler: async (params, { runtime, pairedDeviceId, clientKind, clientCapabilities }) => {
      await restoreStructuredTabsIfSupported({ runtime, clientKind, clientCapabilities })
      return projectSessionTabsForClient(
        await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId),
        clientKind,
        clientCapabilities,
        isStructuredNativeChatEnabled(runtime)
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
    handler: async (
      params,
      { runtime, signal, clientKind, pairedDeviceId, clientCapabilities }
    ) => {
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
        ...(pairedDeviceId
          ? {
              supportsSplitGroupPlacement:
                clientCapabilities?.includes(
                  SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY
                ) === true
            }
          : {}),
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
      { runtime, connectionId, requestId, pairedDeviceId, clientKind, clientCapabilities, signal },
      emit
    ) => {
      let subscriptionId: string | null = null
      let released = false
      let endOnRelease = true
      let stopListening = (): void => {}
      // Safe without a version check: any other release of this key runs our cleanup first, which latches `released`.
      const release = (): void => {
        if (!released && subscriptionId) {
          runtime.cleanupSubscription(subscriptionId)
        }
      }
      const register = (worktreeId: string): void => {
        const cleanupPrefix = `session.tabs:${connectionId ?? 'local'}:${worktreeId}`
        // Why: shared-control can carry multiple subscribers for one worktree on
        // one socket; include the RPC id so one subscriber cannot evict another.
        subscriptionId = requestId ? `${cleanupPrefix}:${requestId}` : cleanupPrefix
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            if (released) {
              return
            }
            released = true
            signal?.removeEventListener('abort', release)
            stopListening()
            if (endOnRelease) {
              emit({ type: 'end' })
            }
          },
          connectionId
        )
        if (signal?.aborted) {
          release()
        } else {
          signal?.addEventListener('abort', release, { once: true })
        }
      }
      // Why: register before any await so an unsubscribe or socket close during setup
      // finds the stream; only an `id:` selector (every phone and web client) names it up front.
      const explicitWorktreeId = getExplicitWorktreeIdSelector(params.worktree)
      if (explicitWorktreeId) {
        register(explicitWorktreeId)
      }
      try {
        await restoreStructuredTabsIfSupported({ runtime, clientKind, clientCapabilities })
        if (released) {
          return
        }
        const initial = await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId)
        if (released) {
          return
        }
        if (!subscriptionId) {
          register(initial.worktree)
          if (released) {
            return
          }
        }
        const subscribedWorktree = initial.worktree
        const withProofDelta = createSessionTabsRetirementProofDelta(clientCapabilities)
        emit({
          type: 'snapshot',
          ...withProofDelta(
            projectSessionTabsForClient(
              initial,
              clientKind,
              clientCapabilities,
              isStructuredNativeChatEnabled(runtime)
            )
          )
        })
        if (released) {
          return
        }
        stopListening = runtime.onMobileSessionTabsChanged((snapshot) => {
          if (snapshot.worktree === subscribedWorktree) {
            emit({
              type: 'updated',
              ...withProofDelta(
                projectSessionTabsForClient(
                  snapshot,
                  clientKind,
                  clientCapabilities,
                  isStructuredNativeChatEnabled(runtime)
                )
              )
            })
          }
        }, pairedDeviceId)
      } catch (error) {
        // A stream already ended by its release must not also report an error.
        if (released) {
          return
        }
        endOnRelease = false
        release()
        throw error
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
    handler: (_params, context, emit) => subscribeSessionTabsInventory(context, emit)
  }),
  defineMethod({
    name: 'session.tabs.unsubscribeAll',
    params: SessionTabsUnsubscribeAllParams,
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
