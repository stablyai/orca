import type {
  MobileWebSessionSnapshotResult,
  MobileWebSessionTab
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import { detectMobileFileLanguage } from './mobile-file-language'
import type { MobileSessionTab, SessionTabsResult } from './mobile-session-route-types'

export function mobileWebSessionTabPresentation(
  snapshot: MobileWebSessionSnapshotResult
): SessionTabsResult {
  return {
    worktree: snapshot.workspaceId,
    publicationEpoch: snapshot.publicationEpoch,
    snapshotVersion: snapshot.snapshotVersion,
    workspaceTransportState: snapshot.workspaceTransportState,
    activeTabId: snapshot.activeTabId,
    activeTabType: snapshot.activeTabType,
    tabs: snapshot.tabs.map((tab) => presentTab(tab, snapshot))
  }
}

function presentTab(
  tab: MobileWebSessionTab,
  snapshot: MobileWebSessionSnapshotResult
): MobileSessionTab {
  if (tab.type === 'terminal') {
    return {
      ...tab,
      terminal: tab.status === 'ready' ? tab.id : null
    }
  }
  if (tab.type === 'markdown') {
    const relativePath = tab.relativePath ?? ''
    return {
      ...tab,
      filePath: syntheticFileIdentity(tab.id),
      relativePath,
      isDirty: tab.isDirty === true,
      documentVersion: `${snapshot.publicationEpoch}:${snapshot.snapshotVersion}:${tab.id}`
    }
  }
  if (tab.type === 'file') {
    const relativePath = tab.relativePath ?? ''
    return {
      ...tab,
      filePath: syntheticFileIdentity(tab.id),
      relativePath,
      language: detectMobileFileLanguage(relativePath, tab.language),
      isDirty: false
    }
  }
  return {
    ...tab,
    browserWorkspaceId: tab.browserPageId
  }
}

function syntheticFileIdentity(tabId: string): string {
  return `mobile-web-tab:${tabId}`
}
