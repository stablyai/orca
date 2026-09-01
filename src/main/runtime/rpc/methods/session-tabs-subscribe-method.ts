import { defineStreamingMethod, type RpcAnyMethod } from '../core'
import { WorktreeTabSelector } from './session-tabs-schemas'
import { projectSessionTabAgentStatus } from './session-tab-agent-status-projection'

/** Live per-worktree tab snapshots: one initial snapshot, then updates until unsubscribe. */
export const SESSION_TABS_SUBSCRIBE_METHOD: RpcAnyMethod = defineStreamingMethod({
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
      ...projectSessionTabAgentStatus(initial, clientKind, clientCapabilities)
    })
    initialized = true
    if (closed) {
      return
    }

    unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
      if (snapshot.worktree === subscribedWorktree) {
        emit({
          type: 'updated',
          ...projectSessionTabAgentStatus(snapshot, clientKind, clientCapabilities)
        })
      }
    }, pairedDeviceId)
    if (closed) {
      unsubscribe()
    }
  }
})
