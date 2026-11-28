import { isDeepStrictEqual } from 'node:util'
import { readCreatedWorkspaceLaunch } from '../../../../agent-launch/agent-launch-created-workspace'
import { getExplicitWorktreeIdSelector } from '../../../workspaces/catalog/runtime-worktree-selection'
import { worktreeIdentityKey, worktreeIdsEqual } from '../../../../../shared/worktree/id'
import { defineMethod, defineStreamingMethod } from '../../core'
import { WorktreeTabSelector } from '../../../../../shared/rpc-contract/session-tabs/session-tabs-schemas-params'
import { SessionTabsSubscribeAllParams } from '../../../../../shared/rpc-contract/session-tabs/session-tabs-params'
import { SESSION_TAB_CLOSE_METHODS } from './session-tab-close-methods'
import {
  listSessionTabsInventory,
  projectSessionTabsForClient,
  subscribeSessionTabsInventory
} from './session-tabs-inventory'
import { SESSION_TAB_MARKDOWN_METHODS } from './session-tab-markdown-methods'
import { SESSION_TAB_MUTATION_METHODS } from './session-tab-mutation-methods'
import { SESSION_TAB_SHELL_CHOICE_METHODS } from './session-tab-shell-choice-methods'
import { SESSION_TAB_CREATE_TERMINAL_METHOD } from './session-tab-create-terminal-method'
import { createSessionTabsStreamDelta } from './session-tabs-sender-delta'
import {
  projectSessionTabUnreadForClient,
  sessionTabsShowAnyPane,
  sessionTabUnreadMarks
} from './session-tab-unread-projection'
import { prepareStructuredTabsIfSupported } from './structured-session-tab-restore'
import '../../../../../shared/remote-runtime/protocol/protocol-version'
import { createSessionTabsTabDeltaEncoder } from '../../../../../shared/remote-runtime/session-graph/session-tabs-tab-delta'
import {
  SESSION_TABS_UNSUBSCRIBE_METHOD,
  SESSION_TABS_UNSUBSCRIBE_ALL_METHOD
} from './session-tabs-unsubscribe'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../shared/sidebar-list/feed/sidebar-inputs-switch'

export const SESSION_TAB_METHODS = [
  defineMethod({
    name: 'session.tabs.list',
    permission: 'workspace',
    params: WorktreeTabSelector,
    handler: async (params, { runtime, pairedDeviceId, clientKind, clientCapabilities }) => {
      await prepareStructuredTabsIfSupported({ runtime, clientKind, clientCapabilities })
      const result = projectSessionTabUnreadForClient(
        runtime,
        projectSessionTabsForClient(
          await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId, {
            includeInitialSurfaceLaunch: true,
            includeAgentSenders: clientKind !== 'mobile'
          }),
          clientKind,
          clientCapabilities,
          runtime
        ),
        clientKind
      )
      runtime.observeClientHostedPageSnapshots?.([result], pairedDeviceId)
      return result
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
  ...SESSION_TAB_SHELL_CHOICE_METHODS,
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
      const observation = Symbol('session-tabs-stream')
      let subscriptionId: string | null = null
      let released = false
      let endOnRelease = true
      let stopListening = (): void => {}
      let stopReprojecting = (): void => {}
      // Safe without a version check: any other release of this key runs our cleanup first, which latches `released`.
      const release = (): void => {
        if (!released && subscriptionId) {
          runtime.cleanupSubscription(subscriptionId)
        } else {
          released = true
          stopReprojecting()
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
            runtime.forgetClientHostedPageObservation?.(pairedDeviceId, observation)
            stopReprojecting()
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
      const withProofDelta = createSessionTabsStreamDelta(clientCapabilities)
      const tabDelta = createSessionTabsTabDeltaEncoder(clientCapabilities)
      const project = (
        snapshot: NonNullable<typeof currentSnapshot>,
        capabilities = capabilitySource?.current ?? clientCapabilities
      ) =>
        projectSessionTabUnreadForClient(
          runtime,
          projectSessionTabsForClient(snapshot, clientKind, capabilities, runtime),
          clientKind
        )
      let sentUnreadMarks = ''
      const emitSnapshot = (
        projected: NonNullable<typeof currentSnapshot>,
        type: 'snapshot' | 'updated'
      ): void => {
        if (released) {
          return
        }
        sentUnreadMarks = currentSnapshot
          ? sessionTabUnreadMarks(runtime, currentSnapshot, clientKind)
          : ''
        const launch = readCreatedWorkspaceLaunch(runtime, projected.worktree)
        const launchAware = launch ? { ...projected, initialSurfaceLaunch: launch } : projected
        emit({
          type,
          ...(type === 'snapshot'
            ? tabDelta.full(withProofDelta(launchAware))
            : tabDelta.update(withProofDelta(launchAware)))
        })
        if (!released) {
          runtime.observeClientHostedPageSnapshots?.([projected], pairedDeviceId, observation)
        }
      }
      const stopObservingCapabilities =
        capabilitySource?.observe((previous) => {
          if (!released && currentSnapshot) {
            const projected = project(currentSnapshot)
            // The last frame was projected with the previous set; a change it ignores sends nothing.
            if (!isDeepStrictEqual(projected, project(currentSnapshot, previous))) {
              emitSnapshot(projected, 'updated')
            }
          }
        }) ?? (() => {})
      // Verdicts move on every agent step; project and re-send only when this workspace's unread tabs change.
      const stopObservingVerdicts =
        clientKind === 'mobile'
          ? runtime.onAgentListChanged((paneKeys) => {
              if (
                !released &&
                currentSnapshot &&
                (paneKeys === null || sessionTabsShowAnyPane(currentSnapshot, paneKeys)) &&
                sessionTabUnreadMarks(runtime, currentSnapshot, clientKind) !== sentUnreadMarks
              ) {
                emitSnapshot(project(currentSnapshot), 'updated')
              }
            })
          : () => {}
      stopReprojecting = () => {
        stopObservingCapabilities()
        stopObservingVerdicts()
      }
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
        const initial = await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId, {
          includeAgentSenders: clientKind !== 'mobile'
        })
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
        emitSnapshot(project(initial), 'snapshot')
        if (released) {
          return
        }
        const acceptsWorktree = (worktree: string): boolean => {
          if (released) {
            return false
          }
          if (worktree !== subscribedWorktree && worktreeIdsEqual(worktree, subscribedWorktree)) {
            // Subscribe can precede publication of the host's stored spelling.
            try {
              subscribedWorktree =
                runtime.getExplicitSessionWorktreeIdSelector(`id:${initial.worktree}`) ??
                subscribedWorktree
            } catch {
              // An ambiguous alias cannot authorize switching to either session.
              return false
            }
          }
          return worktree === subscribedWorktree
        }
        stopListening = runtime.onMobileSessionTabsChanged(
          (snapshot) => {
            if (released) {
              return
            }
            // Keep one stream spelling because clients index frames by worktree.
            const streamSnapshot =
              snapshot.worktree === initial.worktree
                ? snapshot
                : { ...snapshot, worktree: initial.worktree }
            const { navigationIntent: _intent, ...retained } = streamSnapshot
            currentSnapshot = retained
            emitSnapshot(project(streamSnapshot), 'updated')
          },
          pairedDeviceId,
          clientKind,
          { observation: 'caller', acceptsWorktree }
        )
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
  SESSION_TABS_UNSUBSCRIBE_METHOD,
  defineStreamingMethod({
    name: 'session.tabs.subscribeAll',
    permission: 'workspace',
    params: SessionTabsSubscribeAllParams,
    handler: (params, context, emit) => subscribeSessionTabsInventory(context, emit, params?.scope)
  }),
  SESSION_TABS_UNSUBSCRIBE_ALL_METHOD,
  ...SESSION_TAB_MARKDOWN_METHODS
]
