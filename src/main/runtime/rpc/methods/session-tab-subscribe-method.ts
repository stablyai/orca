import { isDeepStrictEqual } from 'node:util'
import { defineStreamingMethod } from '../core'
import { WorktreeTabSelector } from '../../../../shared/rpc-contract/session-tabs-schemas-params'
import { getExplicitWorktreeIdSelector } from '../../runtime-worktree-selection'
import { worktreeIdentityKey, worktreeIdsEqual } from '../../../../shared/worktree/id'
import { createSessionTabsStreamDelta } from './session-tabs-sender-delta'
import { createSessionTabsTabDeltaEncoder } from '../../../../shared/session-tabs-tab-delta'
import { projectSessionTabsForClient } from './session-tabs-inventory'
import { prepareStructuredTabsIfSupported } from './structured-session-tab-restore'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../shared/sidebar-inputs-switch'

export const SESSION_TAB_SUBSCRIBE_METHOD = defineStreamingMethod({
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
        stopListening()
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
    let initial: NonNullable<typeof currentSnapshot> | undefined
    let subscribedWorktree = ''
    let deliveredSequence = -1
    const pendingSnapshots = new Map<
      string,
      { snapshot: NonNullable<typeof currentSnapshot>; sequence: number }
    >()
    const withProofDelta = createSessionTabsStreamDelta(clientCapabilities)
    const tabDelta = createSessionTabsTabDeltaEncoder(clientCapabilities)
    const project = (
      snapshot: NonNullable<typeof currentSnapshot>,
      capabilities = capabilitySource?.current ?? clientCapabilities
    ) => projectSessionTabsForClient(snapshot, clientKind, capabilities)
    const acceptSnapshot = (
      snapshot: NonNullable<typeof currentSnapshot>,
      sequence: number
    ): void => {
      const baseline = initial
      if (!baseline || sequence <= deliveredSequence) {
        return
      }

      if (
        snapshot.worktree !== subscribedWorktree &&
        worktreeIdsEqual(snapshot.worktree, subscribedWorktree)
      ) {
        // Subscribe can precede publication of the host's stored spelling.
        try {
          subscribedWorktree =
            runtime.getExplicitSessionWorktreeIdSelector(`id:${baseline.worktree}`) ??
            subscribedWorktree
        } catch {
          // An ambiguous alias cannot authorize switching to either session.
          return
        }
      }
      if (snapshot.worktree === subscribedWorktree) {
        // Keep one stream spelling because clients index frames by worktree.
        const streamSnapshot =
          snapshot.worktree === baseline.worktree
            ? snapshot
            : { ...snapshot, worktree: baseline.worktree }
        const { navigationIntent: _intent, ...retained } = streamSnapshot
        currentSnapshot = retained
        emit({
          type: 'updated',
          ...tabDelta.update(withProofDelta(project(streamSnapshot)))
        })
      }
      if (snapshot.worktree === subscribedWorktree) {
        deliveredSequence = sequence
      }
    }
    stopCapabilities =
      capabilitySource?.observe((previous) => {
        if (!released && currentSnapshot) {
          const projected = project(currentSnapshot)
          // The last frame was projected with the previous set; a change it ignores sends nothing.
          if (!isDeepStrictEqual(projected, project(currentSnapshot, previous))) {
            emit({ type: 'updated', ...tabDelta.update(withProofDelta(projected)) })
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
      stopListening = runtime.onMobileSessionTabsChanged(
        (snapshot, sequence) => {
          if (released) {
            return
          }
          if (!initial) {
            const pending = pendingSnapshots.get(snapshot.worktree)
            if (!pending || pending.sequence < sequence) {
              pendingSnapshots.set(snapshot.worktree, { snapshot, sequence })
            }
            return
          }
          acceptSnapshot(snapshot, sequence)
        },
        pairedDeviceId,
        clientKind
      )
      const captured = await runtime.listMobileSessionTabsWithChangeSequence(
        params.worktree,
        pairedDeviceId,
        {
          includeAgentSenders: clientKind !== 'mobile'
        }
      )
      initial = captured.snapshot
      if (released) {
        return
      }
      if (!subscriptionId) {
        register(initial.worktree)
        if (released) {
          return
        }
      }
      subscribedWorktree = initial.worktree
      deliveredSequence = captured.changeSequence
      currentSnapshot = initial
      emit({
        type: 'snapshot',
        ...tabDelta.full(withProofDelta(project(initial)))
      })
      if (released) {
        return
      }
      for (const pending of [...pendingSnapshots.values()].sort(
        (a, b) => a.sequence - b.sequence
      )) {
        acceptSnapshot(pending.snapshot, pending.sequence)
      }
      pendingSnapshots.clear()
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
})
