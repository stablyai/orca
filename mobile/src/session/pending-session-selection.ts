import type { MobileSessionTab } from './mobile-session-route-types'

/**
 * The tab the phone has chosen but the host's tab list has not confirmed yet.
 *
 * One value rather than one ref per identifier, so a tab choice, a terminal choice and a launch
 * cannot each leave a stale pick behind for the next snapshot to act on.
 * - `tab`: a tab the user picked, by the host's tab id.
 * - `terminal`: a terminal by its handle; its tab id when the phone already knew it.
 * - `launched`: a surface a launch just started, which may not be in the tab list yet: a terminal by
 *   handle, a chat by session id (never a predicted tab id). It waits a bounded number of snapshots.
 */
export type PendingSessionSelection =
  | { kind: 'tab'; tabId: string }
  | { kind: 'terminal'; handle: string; tabId: string | null }
  | {
      kind: 'launched'
      surface: { handle: string } | { sessionId: string }
      snapshotsLeft: number
    }

// Why: a launch reply can beat its tab's publication; a few snapshots cover that without a timer.
export const LAUNCHED_SELECTION_SNAPSHOT_BUDGET = 5

export function launchedSelection(
  surface: { handle: string } | { sessionId: string }
): PendingSessionSelection {
  return { kind: 'launched', surface, snapshotsLeft: LAUNCHED_SELECTION_SNAPSHOT_BUDGET }
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
 * Turns a launched surface into an ordinary pick once its tab is in the list. `missed` says the tab
 * was not there yet, so the caller can ask for the list again; the budget ends the wait.
 */
export function resolveLaunchedSelection(
  selection: PendingSessionSelection | null,
  tabs: readonly MobileSessionTab[]
): { selection: PendingSessionSelection | null; missed: boolean } {
  if (selection?.kind !== 'launched') {
    return { selection, missed: false }
  }
  const { surface } = selection
  if ('handle' in surface) {
    const terminal = tabs.find(
      (tab): tab is Extract<MobileSessionTab, { type: 'terminal' }> =>
        tab.type === 'terminal' && tab.terminal === surface.handle
    )
    if (terminal) {
      return {
        selection: { kind: 'terminal', handle: surface.handle, tabId: terminal.id },
        missed: false
      }
    }
  } else {
    const chat = tabs.find(
      (tab) => tab.type === 'agent-session' && tab.sessionId === surface.sessionId
    )
    if (chat) {
      return { selection: { kind: 'tab', tabId: chat.id }, missed: false }
    }
  }
  const snapshotsLeft = selection.snapshotsLeft - 1
  return {
    selection: snapshotsLeft > 0 ? { ...selection, snapshotsLeft } : null,
    missed: true
  }
}

/** Whether a terminal's webview should subscribe as the intended pane: picked or just launched. */
export function pendingSelectionWantsHandle(
  selection: PendingSessionSelection | null,
  handle: string
): boolean {
  if (selection?.kind === 'terminal') {
    return selection.handle === handle
  }
  return (
    selection?.kind === 'launched' &&
    'handle' in selection.surface &&
    selection.surface.handle === handle
  )
}
