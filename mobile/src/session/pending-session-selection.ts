import type { MobileSessionTab } from './mobile-session-route-types'

// Use one pending choice so tab, handle and launch selections cannot each leave stale state; later picks replace launch-owned locks.
export type PendingSessionSelection =
  | { kind: 'tab'; tabId: string }
  | { kind: 'terminal'; handle: string; tabId: string | null }
  | {
      kind: 'launched'
      lock: string
      surface: LaunchedSurface
      snapshotsLeft: number | null
    }

// Match launches by reserved pane, returned handle or session id; structured chats are not listed under the reserved tab id.
export type LaunchedSurface = {
  pane: { tabId: string; leafId: string } | null
  sessionId: string | null
  handle: string | null
}

// Why: a launch reply can beat its tab's publication; a few snapshots cover that without a timer.
export const LAUNCHED_SELECTION_SNAPSHOT_BUDGET = 5

export function launchedSelection(
  lock: string,
  surface: Partial<LaunchedSurface>,
  snapshotsLeft: number | null = LAUNCHED_SELECTION_SNAPSHOT_BUDGET
): PendingSessionSelection {
  return {
    kind: 'launched',
    lock,
    surface: { pane: null, sessionId: null, handle: null, ...surface },
    snapshotsLeft
  }
}

// Apply only the matching launch’s reply so later user picks survive.
export function withLaunchReply(
  selection: PendingSessionSelection | null,
  lock: string,
  reply: { handle: string } | { sessionId: string }
): PendingSessionSelection | null {
  if (selection?.kind !== 'launched' || selection.lock !== lock) {
    return selection
  }
  return {
    ...selection,
    surface: { ...selection.surface, ...reply },
    snapshotsLeft: LAUNCHED_SELECTION_SNAPSHOT_BUDGET
  }
}

// Clear only the unanswered launch’s own wait, preserving newer picks.
export function withoutUnansweredLaunch(
  selection: PendingSessionSelection | null,
  lock: string
): PendingSessionSelection | null {
  return selection?.kind === 'launched' &&
    selection.lock === lock &&
    selection.snapshotsLeft === null
    ? null
    : selection
}

export function pendingSelectionTabId(selection: PendingSessionSelection | null): string | null {
  return selection?.kind === 'tab' || selection?.kind === 'terminal' ? selection.tabId : null
}

export function pendingSelectionHandle(selection: PendingSessionSelection | null): string | null {
  return selection?.kind === 'terminal' ? selection.handle : null
}

export function withoutPendingTabId(
  selection: PendingSessionSelection | null
): PendingSessionSelection | null {
  if (selection?.kind === 'terminal') {
    return { ...selection, tabId: null }
  }
  return selection?.kind === 'tab' ? null : selection
}

export function withoutPendingHandle(
  selection: PendingSessionSelection | null
): PendingSessionSelection | null {
  if (selection?.kind !== 'terminal') {
    return selection
  }
  return selection.tabId ? { kind: 'tab', tabId: selection.tabId } : null
}

export function resolveLaunchedSelection(
  selection: PendingSessionSelection | null,
  tabs: readonly MobileSessionTab[]
): { selection: PendingSessionSelection | null; landedTabId: string | null } {
  if (selection?.kind !== 'launched') {
    return { selection, landedTabId: null }
  }
  const landed = tabs.find((tab) => isLaunchedTab(tab, selection.surface))
  if (landed) {
    return {
      selection:
        landed.type === 'terminal' && landed.terminal
          ? { kind: 'terminal', handle: landed.terminal, tabId: landed.id }
          : { kind: 'tab', tabId: landed.id },
      landedTabId: landed.id
    }
  }
  if (selection.snapshotsLeft === null) {
    return { selection, landedTabId: null }
  }
  const snapshotsLeft = selection.snapshotsLeft - 1
  return {
    selection: snapshotsLeft > 0 ? { ...selection, snapshotsLeft } : null,
    landedTabId: null
  }
}

export function isLaunchedSurfaceListed(
  tabs: readonly MobileSessionTab[],
  surface: Partial<LaunchedSurface>
): boolean {
  const known: LaunchedSurface = { pane: null, sessionId: null, handle: null, ...surface }
  // A host may list a launch's terminal tab before its agent exists; only a terminal proves a start.
  return tabs.some(
    (tab) => isLaunchedTab(tab, known) && (tab.type !== 'terminal' || tab.terminal !== null)
  )
}

function isLaunchedTab(tab: MobileSessionTab, surface: LaunchedSurface): boolean {
  if (tab.type === 'agent-session') {
    return surface.sessionId !== null && tab.sessionId === surface.sessionId
  }
  if (tab.type !== 'terminal') {
    return false
  }
  return (
    (surface.pane !== null &&
      tab.parentTabId === surface.pane.tabId &&
      tab.leafId === surface.pane.leafId) ||
    (surface.handle !== null && tab.terminal === surface.handle)
  )
}

export function pendingSelectionWantsHandle(
  selection: PendingSessionSelection | null,
  handle: string
): boolean {
  if (selection?.kind === 'terminal') {
    return selection.handle === handle
  }
  return selection?.kind === 'launched' && selection.surface.handle === handle
}
