import { isTerminalLeafId, makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-session-contracts'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/runtime-mobile-session-tab-contracts'

export type FloatingPtyBinding = { tabId: string; paneKey: string }

export function indexFloatingSnapshotPtyBindings(
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
  paneKeyForTab: (tab: RuntimeMobileSessionTerminalTab) => string
): Map<string, FloatingPtyBinding> {
  const bindings = new Map<string, FloatingPtyBinding>()
  for (const tab of snapshot?.tabs ?? []) {
    if (tab.type !== 'terminal') {
      continue
    }
    if (tab.ptyId) {
      bindings.set(tab.ptyId, { tabId: tab.parentTabId, paneKey: paneKeyForTab(tab) })
    }
    for (const [leafId, ptyId] of Object.entries(tab.parentLayout?.ptyIdsByLeafId ?? {})) {
      bindings.set(ptyId, {
        tabId: tab.parentTabId,
        paneKey: isTerminalLeafId(leafId)
          ? makePaneKey(tab.parentTabId, leafId)
          : `${tab.parentTabId}:${/^pane:(\d+)$/.exec(leafId)?.[1] ?? leafId}`
      })
    }
  }
  return bindings
}
