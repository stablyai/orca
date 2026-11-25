import type { MobileSessionTab } from './mobile-session-tabs'

export type ClosingTerminalTab = { tabId: string; handles: Set<string> }

export function createClosingTerminalTab(
  tab: Extract<MobileSessionTab, { type: 'terminal' }>,
  currentTabs: readonly MobileSessionTab[]
): ClosingTerminalTab {
  const handles = new Set(tab.terminal === null ? [] : [tab.terminal])
  const current = currentTabs.find((candidate) => candidate.id === tab.id)
  if (current?.type === 'terminal' && current.terminal !== null) {
    handles.add(current.terminal)
  }
  return { tabId: tab.id, handles }
}

// Keep observed handles until the close settles, even after the tab drops out of a snapshot.
export function rememberClosingTerminalHandles(
  closes: ReadonlySet<ClosingTerminalTab>,
  handlesByTabId: ReadonlyMap<string, string>
): void {
  for (const close of closes) {
    const handle = handlesByTabId.get(close.tabId)
    if (handle !== undefined) {
      close.handles.add(handle)
    }
  }
}
