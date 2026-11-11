import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-session-contracts'

export function resolveMobileSessionActivationTab(
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
  tabId: string,
  leafId: string | undefined
) {
  const directTab = snapshot?.tabs.find((candidate) => candidate.id === tabId)
  return leafId
    ? ((directTab?.type === 'terminal' && directTab.leafId === leafId ? directTab : undefined) ??
        snapshot?.tabs.find(
          (candidate) =>
            candidate.type === 'terminal' &&
            candidate.parentTabId === tabId &&
            candidate.leafId === leafId
        ))
    : (directTab ??
        snapshot?.tabs.find(
          (candidate) => candidate.type === 'terminal' && candidate.parentTabId === tabId
        ) ??
        snapshot?.tabs.find(
          (candidate) => candidate.type === 'browser' && candidate.browserWorkspaceId === tabId
        ))
}
