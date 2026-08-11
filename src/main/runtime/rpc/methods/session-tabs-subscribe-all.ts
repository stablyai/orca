import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { defineStreamingMethod } from '../core'
import { projectSessionTabAgentStatus } from './session-tab-agent-status-projection'

export const SESSION_TABS_SUBSCRIBE_ALL_METHOD = defineStreamingMethod({
  name: 'session.tabs.subscribeAll',
  params: null,
  handler: async (
    _params,
    { runtime, connectionId, requestId, pairedDeviceId, clientKind, clientCapabilities },
    emit
  ) => {
    let unsubscribe = (): void => {}
    let closed = false
    // Why: initial inventory errors should return one RPC error, not a leaked cleanup that later emits end.
    let initialized = false
    const bufferedByWorktree = new Map<string, RuntimeMobileSessionTabsResult>()
    const cleanupPrefix = `session.tabs:${connectionId ?? 'local'}:*`
    const subscriptionId = requestId ? `${cleanupPrefix}:${requestId}` : cleanupPrefix
    // Why: one socket can carry sibling subscribers; the RPC id keeps their cleanup independent.
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
    const subscription = await runtime
      .subscribeAllMobileSessionTabs((snapshot) => {
        if (!initialized) {
          bufferedByWorktree.set(snapshot.worktree, snapshot)
          return
        }
        emit({
          type: 'updated',
          ...projectSessionTabAgentStatus(snapshot, clientKind, clientCapabilities)
        })
      }, pairedDeviceId)
      .catch((error) => {
        runtime.cleanupSubscription(subscriptionId)
        throw error
      })
    unsubscribe = subscription.unsubscribe
    try {
      if (closed) {
        unsubscribe()
        return
      }
      emit({
        type: 'snapshots',
        snapshots: subscription.snapshots.map((snapshot) =>
          projectSessionTabAgentStatus(snapshot, clientKind, clientCapabilities)
        )
      })
      initialized = true
      if (closed) {
        return
      }
      for (const buffered of bufferedByWorktree.values()) {
        emit({
          type: 'updated',
          ...projectSessionTabAgentStatus(buffered, clientKind, clientCapabilities)
        })
        if (closed) {
          return
        }
      }
      bufferedByWorktree.clear()
    } catch (error) {
      runtime.cleanupSubscription(subscriptionId)
      throw error
    }
  }
})
