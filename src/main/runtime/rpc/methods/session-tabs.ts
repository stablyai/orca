import { isDeepStrictEqual } from 'node:util'
import { getExplicitWorktreeIdSelector } from '../../runtime-worktree-selection'
import { worktreeIdentityKey, worktreeIdsEqual } from '../../../../shared/worktree/id'
import { defineMethod, defineStreamingMethod } from '../core'
import {
  SessionTabsUnsubscribe,
  WorktreeTabSelector
} from '../../../../shared/rpc-contract/session-tabs-schemas-params'
import { SESSION_TAB_CREATE_TERMINAL_METHOD } from './session-tab-create-terminal-method'
import { SESSION_TAB_CLOSE_METHODS } from './session-tab-close-methods'
import {
  listSessionTabsInventory,
  projectSessionTabsForClient,
  subscribeSessionTabsInventory
} from './session-tabs-inventory'
import { SESSION_TAB_MARKDOWN_METHODS } from './session-tab-markdown-methods'
import { SESSION_TAB_MUTATION_METHODS } from './session-tab-mutation-methods'
import { createSessionTabsRetirementProofDelta } from './session-tabs-retirement-proof-delta'
import { createSessionTabsStoppedScreenOnce } from './session-tabs-stopped-screen-once'
import { prepareStructuredTabsIfSupported } from './structured-session-tab-restore'
import { SessionTabsUnsubscribeAllParams } from '../../../../shared/rpc-contract/session-tabs-params'
import { createSessionTabsTabDeltaEncoder } from '../../../../shared/session-tabs-tab-delta'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../shared/sidebar-inputs-switch'

export const SESSION_TAB_METHODS = [
  defineMethod({
    name: 'session.tabs.list',
    permission: 'workspace',
    params: WorktreeTabSelector,
    handler: async (params, { runtime, pairedDeviceId, clientKind, clientCapabilities }) => {
      await prepareStructuredTabsIfSupported({ runtime, clientKind, clientCapabilities })
      return projectSessionTabsForClient(
        await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId, {
          includeInitialSurfaceLaunch: true
        }),
        clientKind,
        clientCapabilities
      )
    }
  }),
  defineMethod({
    name: 'session.tabs.listAll',
    permission: 'workspace',
    params: null,
    handler: async (_params, context) => {
      await prepareStructuredTabsIfSupported(context)
      return listSessionTabsInventory(context)
    }
  }),
  ...SESSION_TAB_MUTATION_METHODS,
  ...SESSION_TAB_CLOSE_METHODS,
  SESSION_TAB_CREATE_TERMINAL_METHOD,
  defineStreamingMethod({
    name: 'session.tabs.subscribe',
    permission: 'workspace',
    params: WorktreeTabSelector,
    handler: async (
      params,
      {
        runtime,
        connectionId,
        requestId,
        pairedDeviceId,
        clientKind,
        clientCapabilities,
        capabilitySource,
        signal
      },
      emit
    ) => {
      let subscriptionId: string | null = null
      let released = false
      let endOnRelease = true
      let stopListening = (): void => {}
      let stopCapabilities = (): void => {}
      // Safe without a version check: any other release of this key runs our cleanup first, which latches `released`.
      const release = (): void => {
        if (!released && subscriptionId) {
          runtime.cleanupSubscription(subscriptionId)
        } else {
          released = true
          stopCapabilities()
          signal?.removeEventListener('abort', release)
        }
      }
      const register = (worktreeId: string): void => {
        // Accept unsubscribe under the resolved spelling learned from snapshots.
        const cleanupPrefix = `session.tabs:${connectionId ?? 'local'}:${worktreeIdentityKey(worktreeId)}`
        // Include RPC id: multiple same-worktree streams can share one socket without evicting each other.
        subscriptionId = requestId ? `${cleanupPrefix}:${requestId}` : cleanupPrefix
        // Switch point: a phone holding the workspace's session open is looking at it.
        const closePhoneSession =
          ORCA_SIDEBAR_INPUTS_IS_MAIN && clientKind === 'mobile'
            ? runtime.sidebarFacts?.readAndHoldPhoneSession(worktreeId)
            : undefined
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            if (released) {
              return
            }
            released = true
            closePhoneSession?.()
            signal?.removeEventListener('abort', release)
            stopListening()
            stopCapabilities()
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
      let currentSnapshot: Awaited<ReturnType<typeof runtime.listMobileSessionTabs>> | undefined
      const withProofDelta = createSessionTabsRetirementProofDelta(clientCapabilities)
      const withScreenOnce = createSessionTabsStoppedScreenOnce()
      const tabDelta = createSessionTabsTabDeltaEncoder(clientCapabilities)
      const project = (
        snapshot: NonNullable<typeof currentSnapshot>,
        capabilities = capabilitySource?.current ?? clientCapabilities
      ) => projectSessionTabsForClient(snapshot, clientKind, capabilities)
      stopCapabilities =
        capabilitySource?.observe((previous) => {
          if (!released && currentSnapshot) {
            const projected = project(currentSnapshot)
            // The last frame was projected with the previous set; a change it ignores sends nothing.
            if (!isDeepStrictEqual(projected, project(currentSnapshot, previous))) {
              emit({
                type: 'updated',
                ...tabDelta.update(withProofDelta(withScreenOnce(projected)))
              })
            }
          }
        }) ?? (() => {})
      signal?.addEventListener('abort', release, { once: true })
      if (signal?.aborted) {
        release()
        return
      }
      // Register before awaits so unsubscribe finds setup; id: selectors provide identity immediately.
      const explicitWorktreeId = getExplicitWorktreeIdSelector(params.worktree)
      if (explicitWorktreeId) {
        register(explicitWorktreeId)
      }
      try {
        await prepareStructuredTabsIfSupported({ runtime, clientKind, clientCapabilities })
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
        let subscribedWorktree = initial.worktree
        currentSnapshot = initial
        emit({
          type: 'snapshot',
          ...tabDelta.full(withProofDelta(withScreenOnce(project(initial))))
        })
        if (released) {
          return
        }
        stopListening = runtime.onMobileSessionTabsChanged((snapshot) => {
          if (
            snapshot.worktree !== subscribedWorktree &&
            worktreeIdsEqual(snapshot.worktree, subscribedWorktree)
          ) {
            // Subscribe can precede publication of the host's stored spelling.
            try {
              subscribedWorktree =
                runtime.getExplicitSessionWorktreeIdSelector(`id:${initial.worktree}`) ??
                subscribedWorktree
            } catch {
              // An ambiguous alias cannot authorize switching to either session.
              return
            }
          }
          if (snapshot.worktree === subscribedWorktree) {
            // Keep one stream spelling because clients index frames by worktree.
            const streamSnapshot =
              snapshot.worktree === initial.worktree
                ? snapshot
                : { ...snapshot, worktree: initial.worktree }
            const { navigationIntent: _intent, ...retained } = streamSnapshot
            currentSnapshot = retained
            emit({
              type: 'updated',
              ...tabDelta.update(withProofDelta(withScreenOnce(project(streamSnapshot))))
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
    permission: 'workspace',
    params: SessionTabsUnsubscribe,
    handler: async (
      params,
      { runtime, connectionId, pairedDeviceId, subscriptionRegistrationVersion }
    ) => {
      const worktreeId =
        getExplicitWorktreeIdSelector(params.worktree) ??
        (await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId)).worktree
      const connection = connectionId ?? 'local'
      const cleanupPrefix = `session.tabs:${connection}:${worktreeIdentityKey(worktreeId)}`
      if (params.subscriptionId) {
        runtime.cleanupSubscription(`${cleanupPrefix}:${params.subscriptionId}`)
        return { unsubscribed: true }
      }
      runtime.cleanupSubscription(cleanupPrefix)
      // Spare subscribes registered after this unsubscribe arrived.
      runtime.cleanupSubscriptionsByPrefix(`${cleanupPrefix}:`, subscriptionRegistrationVersion)
      return { unsubscribed: true }
    }
  }),
  defineStreamingMethod({
    name: 'session.tabs.subscribeAll',
    permission: 'workspace',
    params: null,
    handler: (_params, context, emit) => subscribeSessionTabsInventory(context, emit)
  }),
  defineMethod({
    name: 'session.tabs.unsubscribeAll',
    permission: 'workspace',
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
