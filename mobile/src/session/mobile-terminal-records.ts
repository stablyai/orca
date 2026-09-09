import type { MobileTerminalTheme } from '../terminal/terminal-webview-contract'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'

export type TerminalRecord = {
  handle: string
  title: string
  terminalTheme?: MobileTerminalTheme
  isActive: boolean
  /** From `terminal.list`; parked and proven-absent leaves report false. */
  connected?: boolean
  /** From `terminal.list`; a live PTY with no leaf, so it never appears as a tab. */
  orphaned?: boolean
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
        // A frame whose only delta is the launch draft appearing or retracting
        // still has to reach the chat composer.
        a.launchDraft === b.launchDraft &&
        a.launchDraftCreatedAt === b.launchDraftCreatedAt &&
        JSON.stringify(a.agentStatus ?? null) === JSON.stringify(b.agentStatus ?? null) &&
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
        a.canGoBack === b.canGoBack &&
        a.canGoForward === b.canGoForward
      )
    case 'agent-session':
      return b.type === 'agent-session' && a.sessionId === b.sessionId && a.agent === b.agent
  }
}

// Reconcile a partial session snapshot against the last known record for the
// same terminal. The snapshot owns live fields (title, activity); the known
// theme only survives when the snapshot omits it, since lightweight snapshots
// can drop it.
function mergeTerminalSnapshotWithKnownRecord(
  snapshot: TerminalRecord,
  known: TerminalRecord
): TerminalRecord {
  return {
    ...snapshot,
    terminalTheme: snapshot.terminalTheme ?? known.terminalTheme
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

// Why: tab snapshots are partial and can transiently omit a live terminal, so absence
// here is only a hint to schedule the `terminal.list` sweep -- never a reason to prune.
// Restricted to connected, non-orphaned handles: parked leaves and orphaned PTYs are
// legitimately absent from tabs forever and would pin the caller to the fast cadence.
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
        mobileTerminalThemesEqual(terminal.terminalTheme, b[index]?.terminalTheme) &&
        terminal.isActive === b[index]?.isActive
    )
  )
}
