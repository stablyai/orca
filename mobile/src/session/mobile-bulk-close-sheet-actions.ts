import type { MarkdownDocState, MobileSessionTab } from './mobile-session-route-types'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { selectBulkCloseTabs } from './mobile-tab-close-selection'
import { getMobileSessionTabTitle } from './mobile-terminal-tab-agent'

export type PendingBulkCloseConfirmation = {
  anchor: MobileSessionTab
  closeCount: number
}

export function describeBulkCloseConfirmation(pending: PendingBulkCloseConfirmation | null) {
  const closeCount = pending?.closeCount ?? 0
  const anchorTitle = pending ? getMobileSessionTabTitle(pending.anchor) : 'this tab'
  return {
    title: closeCount === 1 ? 'Close 1 Other Tab?' : `Close ${closeCount} Other Tabs?`,
    message: pending
      ? `Keep only "${anchorTitle}" open and close ${
          closeCount === 1 ? 'the other tab' : `all ${closeCount} other tabs`
        }?`
      : undefined,
    confirmLabel: closeCount === 1 ? 'Close 1 Tab' : `Close ${closeCount} Tabs`
  }
}

/** Session-route state the bulk close orchestration reads and drives. */
type BulkCloseSheetDeps = {
  sessionTabsRef: { readonly current: readonly MobileSessionTab[] }
  markdownDocs: ReadonlyMap<string, MarkdownDocState>
  activeSessionTabIdRef: { readonly current: string | null }
  switchSessionTab: (tab: MobileSessionTab) => void
  closeSessionTab: (tab: MobileSessionTab) => Promise<void>
  onRequestConfirmBulkClose?: (pending: PendingBulkCloseConfirmation) => void
}

export function selectClosableBulkTabs(
  deps: Pick<BulkCloseSheetDeps, 'sessionTabsRef' | 'markdownDocs'>,
  anchorTabId: string
): MobileSessionTab[] {
  return selectBulkCloseTabs(deps.sessionTabsRef.current, anchorTabId).filter((candidate) => {
    if (candidate.type !== 'markdown') {
      return true
    }
    // Why: the tab list's isDirty can lag behind a phone draft; the local
    // markdown doc state is the authority on unsaved edits.
    const doc = deps.markdownDocs.get(candidate.id)
    return !(doc?.status === 'ready' && doc.isDirty)
  })
}

export async function runBulkCloseSessionTabs(
  deps: Omit<BulkCloseSheetDeps, 'onRequestConfirmBulkClose'>,
  anchor: MobileSessionTab
): Promise<void> {
  const targets = selectClosableBulkTabs(deps, anchor.id)
  const activeWasTargeted = targets.some(
    (candidate) => candidate.id === deps.activeSessionTabIdRef.current
  )
  // Why: activate the anchor before the per-tab close round-trips so the user
  // never sits on a dying tab or an empty pane while the loop runs.
  if (activeWasTargeted) {
    deps.switchSessionTab(anchor)
  }
  for (const target of targets) {
    await deps.closeSessionTab(target)
  }
}

/**
 * Builds the long-press bulk-close entries (Close Others) shared
 * by every session tab sheet. Lives outside the session route to keep the
 * orchestration out of its max-lines budget; anchors are passed by tab id so
 * sheets never need the full tab object.
 */
export function createBulkCloseSheetActions(deps: BulkCloseSheetDeps) {
  return (anchorTabId: string | null | undefined, dismiss: () => void): ActionSheetAction[] => {
    const anchor =
      anchorTabId == null
        ? undefined
        : deps.sessionTabsRef.current.find((candidate) => candidate.id === anchorTabId)
    if (!anchor) {
      return []
    }
    const closable = selectClosableBulkTabs(deps, anchor.id)
    if (closable.length === 0) {
      return []
    }
    const closeCount = closable.length
    const requestConfirm = deps.onRequestConfirmBulkClose
    if (requestConfirm) {
      return [
        {
          label: 'Close Other Tabs',
          destructive: true,
          // Why: wait for the action sheet's native Modal to unmount before
          // presenting ConfirmModal (same dual-Modal race as Rename/Refresh, #10331).
          closeBeforePress: true,
          onPress: () => {
            requestConfirm({ anchor, closeCount })
          }
        }
      ]
    }
    return [
      {
        label: 'Close Other Tabs',
        destructive: true,
        onPress: () => {
          dismiss()
          void runBulkCloseSessionTabs(deps, anchor)
        }
      }
    ]
  }
}

/**
 * Builds the destructive Close entry followed by the bulk-close entries, so
 * per-tab-type sheets in the session route stay at one spread per call site.
 */
export function createCloseWithBulkActions(
  closeSessionTab: (tab: MobileSessionTab) => Promise<void>,
  bulkActions: ReturnType<typeof createBulkCloseSheetActions>
) {
  return (target: MobileSessionTab | null, dismiss: () => void): ActionSheetAction[] => [
    {
      label: 'Close',
      destructive: true,
      onPress: () => {
        dismiss()
        if (target) {
          void closeSessionTab(target)
        }
      }
    },
    ...bulkActions(target?.id, dismiss)
  ]
}
