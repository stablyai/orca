import type { MobileTerminalTheme } from '../terminal/TerminalWebView'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'

export type TerminalRecord = {
  handle: string
  title: string
  terminalTheme?: MobileTerminalTheme
  isActive: boolean
}

export type MobileTerminalSessionTab = {
  type: 'terminal'
  id: string
  title: string
  parentTabId?: string
  leafId?: string
  status?: 'pending-handle' | 'ready'
  terminal: string | null
  agentStatus?: AgentStatusEntry | null
  terminalTheme?: MobileTerminalTheme
  isActive: boolean
}

type MobileSessionTabLike =
  | MobileTerminalSessionTab
  | {
      type: 'markdown'
      id: string
      title?: string
      filePath?: string
      relativePath?: string
      isDirty?: boolean
      documentVersion?: string
      isActive?: boolean
    }
  | {
      type: 'file'
      id: string
      title?: string
      filePath?: string
      relativePath?: string
      language?: string
      isDirty?: boolean
      isActive?: boolean
    }
  | {
      type: 'browser'
      id: string
      title?: string
      browserWorkspaceId?: string
      browserPageId?: string | null
      url?: string
      loading?: boolean
      canGoBack?: boolean
      canGoForward?: boolean
      isActive?: boolean
    }

export function mobileSessionTabsEqual(
  a: readonly MobileSessionTabLike[],
  b: readonly MobileSessionTabLike[]
): boolean {
  return a.length === b.length && a.every((tab, index) => mobileSessionTabEqual(tab, b[index]))
}

function mobileSessionTabEqual(
  a: MobileSessionTabLike,
  b: MobileSessionTabLike | undefined
): boolean {
  if (
    !b ||
    a.type !== b.type ||
    a.id !== b.id ||
    a.title !== b.title ||
    a.isActive !== b.isActive
  ) {
    return false
  }
  switch (a.type) {
    case 'terminal':
      return (
        b.type === 'terminal' &&
        a.parentTabId === b.parentTabId &&
        a.leafId === b.leafId &&
        a.status === b.status &&
        a.terminal === b.terminal &&
        JSON.stringify(a.agentStatus ?? null) === JSON.stringify(b.agentStatus ?? null) &&
        JSON.stringify(a.terminalTheme ?? null) === JSON.stringify(b.terminalTheme ?? null)
      )
    case 'markdown':
      return (
        b.type === 'markdown' &&
        a.filePath === b.filePath &&
        a.relativePath === b.relativePath &&
        a.isDirty === b.isDirty &&
        a.documentVersion === b.documentVersion
      )
    case 'file':
      return (
        b.type === 'file' &&
        a.filePath === b.filePath &&
        a.relativePath === b.relativePath &&
        a.language === b.language &&
        a.isDirty === b.isDirty
      )
    case 'browser':
      return (
        b.type === 'browser' &&
        a.browserWorkspaceId === b.browserWorkspaceId &&
        a.browserPageId === b.browserPageId &&
        a.url === b.url &&
        a.loading === b.loading &&
        a.canGoBack === b.canGoBack &&
        a.canGoForward === b.canGoForward
      )
  }
}

export function mergeTerminalRecordsByCurrentOrder(
  terminalTabs: TerminalRecord[],
  currentTerminals: TerminalRecord[]
): TerminalRecord[] {
  if (currentTerminals.length === 0) {
    return terminalTabs
  }
  const terminalTabsByHandle = new Map(terminalTabs.map((tab) => [tab.handle, tab]))
  const currentHandles = new Set(currentTerminals.map((terminal) => terminal.handle))
  return [
    ...currentTerminals.map((terminal) => terminalTabsByHandle.get(terminal.handle) ?? terminal),
    ...terminalTabs.filter((terminal) => !currentHandles.has(terminal.handle))
  ]
}

export function getTerminalRecordsFromSessionTabs(
  tabs: readonly MobileSessionTabLike[]
): TerminalRecord[] {
  return tabs.flatMap((tab): TerminalRecord[] => {
    if (tab.type !== 'terminal' || typeof tab.terminal !== 'string') {
      return []
    }
    return [
      {
        handle: tab.terminal,
        title: tab.title || 'Terminal',
        terminalTheme: tab.terminalTheme,
        isActive: tab.isActive === true
      }
    ]
  })
}

export function mergeTerminalListWithKnownRecords(
  terminalList: TerminalRecord[],
  currentTerminals: TerminalRecord[],
  sessionTabs: readonly MobileSessionTabLike[]
): TerminalRecord[] {
  const currentTerminalsByHandle = new Map(
    currentTerminals.map((terminal) => [terminal.handle, terminal])
  )
  const sessionTerminalsByHandle = new Map(
    getTerminalRecordsFromSessionTabs(sessionTabs).map((terminal) => [terminal.handle, terminal])
  )
  return terminalList.map((terminal) => {
    const sessionTerminal = sessionTerminalsByHandle.get(terminal.handle)
    const currentTerminal = currentTerminalsByHandle.get(terminal.handle)
    // Why: terminal.list summaries can omit the mobile theme; keep the richer
    // session-tab/current record so polling cannot reset TerminalWebView.
    return {
      ...terminal,
      terminalTheme:
        sessionTerminal?.terminalTheme ?? currentTerminal?.terminalTheme ?? terminal.terminalTheme
    }
  })
}

export function terminalRecordsEqual(
  a: readonly TerminalRecord[],
  b: readonly TerminalRecord[]
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (terminal, index) =>
        terminal.handle === b[index]?.handle &&
        terminal.title === b[index]?.title &&
        JSON.stringify(terminal.terminalTheme ?? null) ===
          JSON.stringify(b[index]?.terminalTheme ?? null) &&
        terminal.isActive === b[index]?.isActive
    )
  )
}
