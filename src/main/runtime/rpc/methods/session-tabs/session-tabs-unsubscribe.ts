import { defineMethod } from '../../core'
import { SessionTabsUnsubscribe } from '../../../../../shared/rpc-contract/session-tabs-schemas-params'
import { SessionTabsUnsubscribeAllParams } from '../../../../../shared/rpc-contract/session-tabs-params'
import { getExplicitWorktreeIdSelector } from '../../../workspaces/catalog/runtime-worktree-selection'
import { worktreeIdentityKey } from '../../../../../shared/worktree/id'

export const SESSION_TABS_UNSUBSCRIBE_METHOD = defineMethod({
  name: 'session.tabs.unsubscribe',
  permission: 'workspace',
  params: SessionTabsUnsubscribe,
  handler: async (
    params,
    { runtime, connectionId, pairedDeviceId, subscriptionRegistrationVersion }
  ) => {
    const worktreeId =
      getExplicitWorktreeIdSelector(params.worktree) ??
      (
        await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId, {
          includeAgentSenders: false
        })
      ).worktree
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
})

export const SESSION_TABS_UNSUBSCRIBE_ALL_METHOD = defineMethod({
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
})
