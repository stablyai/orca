import type { MobileSessionTab } from './mobile-session-route-types'

/**
 * The tab the phone has chosen but the host's tab list has not confirmed yet.
 *
 * One value rather than one ref per identifier, so a tab choice, a terminal choice and a launch
 * cannot each leave a stale pick behind for the next snapshot to act on.
 * - `tab`: a tab the user picked, by the host's tab id.
 * - `terminal`: a terminal by its handle; its tab id when the phone already knew it.
 * - `launched`: the tab a launch is creating, which may not be in the tab list yet. `lock` names the
 *   launch, so only its own reply or landing acts on it and a pick made meanwhile replaces it.
 */
export type PendingSessionSelection =
  | { kind: 'tab'; tabId: string }
  | { kind: 'terminal'; handle: string; tabId: string | null }
  | {
      kind: 'launched'
      lock: string
      surface: LaunchedSurface
      /** Null until the reply: before it, the tab is still being built. */
      snapshotsLeft: number | null
    }

/**
 * How a launched tab is recognised, never by a predicted tab id: a terminal by the pane this device
 * reserved or the handle the reply named, a chat by the session id this device minted or the reply
 * named (a chat is listed under its session, not the reserved tab).
 */
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

/** Adds what the launch's reply named and starts the fallback countdown; a pick made since stays. */
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

/** Drops a launch's wait when it ended without a reply naming a surface; a pick made since stays. */
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

/** Drops the tab-id half of a pick and keeps any terminal handle it carried. */
export function withoutPendingTabId(
  selection: PendingSessionSelection | null
): PendingSessionSelection | null {
  if (selection?.kind === 'terminal') {
    return { ...selection, tabId: null }
  }
  return selection?.kind === 'tab' ? null : selection
}

/** Drops the handle half of a pick and keeps any tab id it carried. */
export function withoutPendingHandle(
  selection: PendingSessionSelection | null
): PendingSessionSelection | null {
  if (selection?.kind !== 'terminal') {
    return selection
  }
  return selection.tabId ? { kind: 'tab', tabId: selection.tabId } : null
}

/**
 * Turns a launched surface into an ordinary pick once its tab is in the list; `landedTabId` names
 * that tab on the snapshot it arrives in. The budget ends the wait.
 */
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

/** Whether the host lists a launch's running surface, which proves the agent started. */
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

/** Whether a terminal's webview should subscribe as the intended pane: picked or just launched. */
export function pendingSelectionWantsHandle(
  selection: PendingSessionSelection | null,
  handle: string
): boolean {
  if (selection?.kind === 'terminal') {
    return selection.handle === handle
  }
  return selection?.kind === 'launched' && selection.surface.handle === handle
}
