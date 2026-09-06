import type { SessionTabsResult } from './mobile-session-route-types'
import type { HostSessionRuntimeCapabilities } from './host-session-runtime-capabilities'
import type { MobileNewTabAgentOption } from './mobile-new-tab-agent-options'

export type HostSessionTabCloseResult =
  | { outcome: 'closed' }
  | { outcome: 'refused'; reason: string | null }

export type HostSessionQuickCommandLaunchResult = {
  snapshot: SessionTabsResult
  tabId: string
  initialInput: { text: string; enter: false; successToast: string } | null
}

export type HostSessionTabOperations = {
  runtimeCapabilities(): Promise<HostSessionRuntimeCapabilities>
  snapshot(workspaceId: string): Promise<SessionTabsResult>
  subscribe(
    workspaceId: string,
    onSnapshot: (snapshot: SessionTabsResult) => void,
    onError: () => void
  ): () => void
  agentOptions(workspaceId: string): Promise<MobileNewTabAgentOption[]>
  createBlank(workspaceId: string): Promise<SessionTabsResult>
  createAgent(
    workspaceId: string,
    agent: MobileNewTabAgentOption['agent']
  ): Promise<SessionTabsResult>
  createQuickCommand?(
    workspaceId: string,
    commandId: string
  ): Promise<HostSessionQuickCommandLaunchResult>
  createBrowser(workspaceId: string, url: string): Promise<{ browserPageId: string }>
  activate(workspaceId: string, tabId: string, leafId?: string): Promise<SessionTabsResult>
  close(workspaceId: string, tabId: string): Promise<HostSessionTabCloseResult>
}
