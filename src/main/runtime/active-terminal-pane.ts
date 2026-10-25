import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-session-contracts'

export type ActiveTerminalPane = { tabId: string; leafId: string }

export function resolveActiveTerminalPane(
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined
): ActiveTerminalPane | null {
  const active = snapshot?.tabs.find((tab) => tab.id === snapshot.activeTabId)
  return active?.type === 'terminal' ? { tabId: active.parentTabId, leafId: active.leafId } : null
}
