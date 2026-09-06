import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import {
  MOBILE_WEB_WORKSPACE_LIST_LIMIT,
  MOBILE_WEB_WORKSPACE_SNAPSHOT_LIMIT
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import { mobileWebWorkspacePresentations } from './mobile-web-workspace-presentation'
import type { HostWorkspaceOperations } from './host-workspace-operations'

export function webHostWorkspaceOperations(client: MobileWebBridgeClient): HostWorkspaceOperations {
  return {
    connectionStateIsRelayed: true,
    async getViewSettings() {
      return (await client.workspaceSettingsSnapshot()).settings
    },
    async setViewSettings(settings) {
      await client.workspaceSettingsUpdate(settings)
    },
    async listRepos() {
      const result = await client.workspaceRepositories()
      return result.repositories
    },
    async listWorkspaces(limit) {
      const requested = Math.min(Math.max(0, limit), MOBILE_WEB_WORKSPACE_LIST_LIMIT)
      const workspaces = []
      let cursor: string | undefined
      while (workspaces.length < requested) {
        const page = await client.workspaceSnapshot({
          limit: Math.min(requested - workspaces.length, MOBILE_WEB_WORKSPACE_SNAPSHOT_LIMIT),
          ...(cursor ? { cursor } : {})
        })
        workspaces.push(...page.workspaces)
        if (!page.nextCursor) {
          break
        }
        cursor = page.nextCursor
      }
      return mobileWebWorkspacePresentations(workspaces)
    },
    async setPinned(workspaceId, pinned) {
      await client.workspaceUpdate({ mutation: 'pin', workspaceId, pinned })
    },
    async removeWorkspace(workspaceId) {
      try {
        await client.workspaceRemove({ workspaceId })
        return true
      } catch {
        return false
      }
    },
    async activateWorkspace(workspaceId) {
      await client.workspaceActivate({ workspaceId })
    },
    async sleepWorkspace(workspaceId) {
      await client.workspaceUpdate({ mutation: 'sleep', workspaceId })
    },
    notifyForeground() {
      // Why: the native shell owns AppState and connection recovery for the hosted page.
    },
    subscribeChanges(listener) {
      const subscription = client.workspaceSubscribe(listener, () => listener({ type: 'error' }))
      void subscription.ready.catch(() => {})
      return subscription.unsubscribe
    }
  }
}
