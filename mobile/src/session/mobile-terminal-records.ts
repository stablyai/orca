import type { MobileTerminalTheme } from '../terminal/terminal-webview-contract'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { BrowserLoadError } from '../../../src/shared/browser-workspace-types'
import { browserLoadErrorsEqual } from '../../../src/shared/browser-load-failure'

export type TerminalRecord = {
  handle: string
  title: string
  terminalTheme?: MobileTerminalTheme
  isActive: boolean
  /** From `terminal.list`; parked and proven-absent leaves report false. */
  connected?: boolean
  /** From `terminal.list`; a live PTY with no leaf, so it never appears as a tab. */
  orphaned?: boolean
  /** From `terminal.list`; the host's own pane identity, which tab snapshots never carry. */
  agentIdentity?: string
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
  nativeChatIdentity?: unknown
  /** Host-provided launch context still parked as an unsent TUI-input draft. */
  launchDraft?: string
  launchDraftCreatedAt?: number
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
      loadError?: BrowserLoadError | null
      canGoBack?: boolean
      canGoForward?: boolean
      isActive?: boolean
    }
  | {
      type: 'agent-session'
      id: string
      title?: string
      sessionId?: string
      agent?: string
      chatStatus?: unknown
      isActive?: boolean
    }

export function mobileTerminalThemesEqual(
  left: MobileTerminalTheme | null | undefined,
  right: MobileTerminalTheme | null | undefined
): boolean {
  if (left === right) {
    return true
  }
  if (!left || !right || left.mode !== right.mode) {
    return false
  }
  const leftColors = left.theme as Readonly<Record<string, unknown>>
  const rightColors = right.theme as Readonly<Record<string, unknown>>
  for (const color in leftColors) {
    if (
      Object.hasOwn(leftColors, color) &&
      (!Object.hasOwn(rightColors, color) || leftColors[color] !== rightColors[color])
    ) {
      return false
    }
  }
  for (const color in rightColors) {
    if (Object.hasOwn(rightColors, color) && !Object.hasOwn(leftColors, color)) {
      return false
    }
  }
  return true
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
        a.launchDraft === b.launchDraft &&
        a.launchDraftCreatedAt === b.launchDraftCreatedAt &&
        JSON.stringify(a.agentStatus ?? null) === JSON.stringify(b.agentStatus ?? null) &&
        JSON.stringify(a.nativeChatIdentity ?? null) ===
          JSON.stringify(b.nativeChatIdentity ?? null) &&
        mobileTerminalThemesEqual(a.terminalTheme, b.terminalTheme)
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
        browserLoadErrorsEqual(a.loadError, b.loadError) &&
        a.canGoBack === b.canGoBack &&
        a.canGoForward === b.canGoForward
      )
    case 'agent-session':
      return (
        b.type === 'agent-session' &&
        a.sessionId === b.sessionId &&
        a.agent === b.agent &&
        JSON.stringify(a.chatStatus ?? null) === JSON.stringify(b.chatStatus ?? null)
      )
  }
}

// Partial snapshots own live fields; omitted theme and host pane identity retain the known values.
function mergeTerminalSnapshotWithKnownRecord(
  snapshot: TerminalRecord,
  known: TerminalRecord
): TerminalRecord {
  return {
    ...snapshot,
    terminalTheme: snapshot.terminalTheme ?? known.terminalTheme,
    agentIdentity: snapshot.agentIdentity ?? known.agentIdentity
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
    ...currentTerminals.map((terminal) => {
      const snapshotTerminal = terminalTabsByHandle.get(terminal.handle)
      return snapshotTerminal
        ? mergeTerminalSnapshotWithKnownRecord(snapshotTerminal, terminal)
        : terminal
    }),
    ...terminalTabs.filter((terminal) => !currentHandles.has(terminal.handle))
  ]
}

// Partial tabs only justify an inventory sweep, never pruning; parked/orphaned handles legitimately lack tabs and must not force fast polling.
export function hasConnectedTerminalAbsentFromSessionTabs(
  currentTerminals: readonly TerminalRecord[],
  tabs: readonly MobileSessionTabLike[]
): boolean {
  const tabbable = currentTerminals.filter(
    (terminal) => terminal.connected === true && terminal.orphaned !== true
  )
  if (tabbable.length === 0) {
    return false
  }
  const tabHandles = new Set(
    getTerminalRecordsFromSessionTabs(tabs).map((terminal) => terminal.handle)
  )
  return tabbable.some((terminal) => !tabHandles.has(terminal.handle))
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
        isActive: tab.isActive === true,
        connected: true
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
    // Keep richer themes absent from terminal.list so polling cannot reset the WebView.
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
        mobileTerminalThemesEqual(terminal.terminalTheme, b[index]?.terminalTheme) &&
        terminal.isActive === b[index]?.isActive &&
        terminal.agentIdentity === b[index]?.agentIdentity
    )
  )
}
