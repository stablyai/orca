import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { isMobileTuiAgent, MOBILE_TUI_AGENT_LABELS } from '../tasks/mobile-tui-agents'
import type { HostSessionTabOperations } from './host-session-tab-operations'
import { mobileWebSessionTabPresentation } from './mobile-web-session-tab-presentation'

export function webHostSessionTabOperations(
  client: MobileWebBridgeClient
): HostSessionTabOperations {
  return {
    runtimeCapabilities() {
      return client.sessionCapabilities({})
    },
    async snapshot(workspaceId) {
      return mobileWebSessionTabPresentation(await client.sessionSnapshot({ workspaceId }))
    },
    subscribe(workspaceId, onSnapshot, onError) {
      const subscription = client.sessionSubscribe(
        { workspaceId },
        (snapshot) => onSnapshot(mobileWebSessionTabPresentation(snapshot)),
        onError
      )
      void subscription.ready.catch(onError)
      return subscription.unsubscribe
    },
    async agentOptions(workspaceId) {
      const result = await client.sessionAgentOptions({ workspaceId })
      return result.agents.filter(isMobileTuiAgent).map((agent) => ({
        agent,
        label: MOBILE_TUI_AGENT_LABELS[agent]
      }))
    },
    async createBlank(workspaceId) {
      await client.sessionCreate({ workspaceId })
      return mobileWebSessionTabPresentation(await client.sessionSnapshot({ workspaceId }))
    },
    async createAgent(workspaceId, agent) {
      await client.sessionCreateAgent({ workspaceId, agent })
      return mobileWebSessionTabPresentation(await client.sessionSnapshot({ workspaceId }))
    },
    async createQuickCommand(workspaceId, commandId) {
      const result = await client.sessionCreateQuickCommand({ workspaceId, commandId })
      return {
        snapshot: mobileWebSessionTabPresentation(await client.sessionSnapshot({ workspaceId })),
        tabId: result.tabId,
        initialInput: result.initialInput
      }
    },
    async createBrowser(workspaceId, url) {
      const result = await client.sessionCreateBrowser({ workspaceId, url })
      return { browserPageId: result.browserPageId }
    },
    async activate(workspaceId, tabId) {
      return mobileWebSessionTabPresentation(await client.sessionActivate({ workspaceId, tabId }))
    },
    async close(workspaceId, tabId) {
      const result = await client.sessionClose({ workspaceId, tabId })
      return result.outcome === 'closed'
        ? { outcome: 'closed' }
        : { outcome: 'refused', reason: result.refusalReason }
    }
  }
}
