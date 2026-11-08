import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionAgentTabStatus,
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab,
  RuntimeMobileSessionTerminalClientTab,
  RuntimeMobileSessionTerminalTab
} from '../../../../src/shared/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsResult } from '../../../../src/shared/runtime-session-contracts'
import type { MirroredEvidenceReceipt } from '../../../../src/shared/agent-status/contracts/agent-status-observation'
import type { MobileNativeChatIdentity } from '../native-chat/mobile-native-chat-eligibility'

export type MobileBrowserTab = Pick<
  RuntimeMobileSessionBrowserTab,
  | 'type'
  | 'id'
  | 'title'
  | 'browserWorkspaceId'
  | 'browserPageId'
  | 'url'
  | 'loading'
  | 'loadError'
  | 'canGoBack'
  | 'canGoForward'
  | 'isActive'
>

export type MobileSessionTabType = NonNullable<RuntimeMobileSessionTabsResult['activeTabType']>

/** What the phone adds to a host terminal tab; a type test keeps these names off the host's tab. */
export type MobileTerminalTabPhoneFields = {
  // Carried across publications so chat stays open before live agent status arrives.
  nativeChatIdentity?: MobileNativeChatIdentity
}

// The phone reads a subset of each host tab; fields older hosts omit are optional here.
export type MobileSessionTab =
  | (Pick<RuntimeMobileSessionTerminalTab, 'type' | 'id' | 'title' | 'isActive'> &
      Partial<
        Pick<
          RuntimeMobileSessionTerminalTab,
          | 'parentTabId'
          | 'leafId'
          | 'agentStatus'
          | 'launchAgent'
          | 'launchDraft'
          | 'launchDraftCreatedAt'
          | 'terminalTheme'
        >
      > & {
        status?: RuntimeMobileSessionTerminalClientTab['status']
        terminal: string | null
      } & MobileTerminalTabPhoneFields)
  | (Pick<
      RuntimeMobileSessionAgentTab,
      'type' | 'id' | 'title' | 'sessionId' | 'agent' | 'isActive'
    > & {
      chatStatus?: RuntimeMobileSessionAgentTabStatus & MirroredEvidenceReceipt
    })
  | Pick<
      RuntimeMobileSessionMarkdownTab,
      | 'type'
      | 'id'
      | 'title'
      | 'filePath'
      | 'relativePath'
      | 'isDirty'
      | 'isActive'
      | 'documentVersion'
    >
  | (Pick<
      RuntimeMobileSessionFileTab,
      | 'type'
      | 'id'
      | 'title'
      | 'filePath'
      | 'relativePath'
      | 'mode'
      | 'oldPath'
      | 'isDirty'
      | 'isActive'
    > & {
      language?: string
      // The phone also opens branch and commit diffs, which the host never publishes.
      diffSource?: RuntimeMobileSessionFileTab['diffSource'] | 'branch' | 'commit'
    })
  | MobileBrowserTab

export type SessionTabsResult = Pick<
  RuntimeMobileSessionTabsResult,
  | 'worktree'
  | 'clientHostedPagesUnreconciled'
  | 'agentSessionsUnverifiable'
  | 'snapshotVersion'
  | 'activeTabId'
  | 'activeTabType'
  | 'navigationIntent'
> &
  Partial<Pick<RuntimeMobileSessionTabsResult, 'publicationEpoch'>> & {
    tabs: MobileSessionTab[]
  }
