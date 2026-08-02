import type {
  MarkdownDocState,
  MobileSessionTab
} from '../../app/h/[hostId]/session/mobile-session-route-types'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import {
  BULK_TAB_CLOSE_ACTIONS,
  selectBulkCloseTabs,
  type BulkTabCloseMode
} from './mobile-tab-close-selection'

/** Session-route state the bulk close orchestration reads and drives. */
type BulkCloseSheetDeps = {
  sessionTabsRef: { readonly current: readonly MobileSessionTab[] }
  markdownDocs: ReadonlyMap<string, MarkdownDocState>
  activeSessionTabIdRef: { readonly current: string | null }
  switchSessionTab: (tab: MobileSessionTab) => void
  closeSessionTab: (tab: MobileSessionTab) => Promise<void>
}

/**
 * Builds the long-press bulk-close entries (Close Others / Left / Right) shared
 * by every session tab sheet. Lives outside the session route to keep the
 * orchestration out of its max-lines budget; anchors are passed by tab id so
 * sheets never need the full tab object.
 */
export function createBulkCloseSheetActions(deps: BulkCloseSheetDeps) {
  const selectClosable = (anchorTabId: string, mode: BulkTabCloseMode) =>
    selectBulkCloseTabs(deps.sessionTabsRef.current, anchorTabId, mode).filter((candidate) => {
      if (candidate.type !== 'markdown') {
        return true
      }
      // Why: the tab list's isDirty can lag behind a phone draft; the local
      // markdown doc state is the authority on unsaved edits.
      const doc = deps.markdownDocs.get(candidate.id)
      return !(doc?.status === 'ready' && doc.isDirty)
    })

  const bulkClose = async (anchor: MobileSessionTab, mode: BulkTabCloseMode) => {
    const targets = selectClosable(anchor.id, mode)
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

  return (anchorTabId: string | null | undefined, dismiss: () => void): ActionSheetAction[] => {
    const anchor =
      anchorTabId == null
        ? undefined
        : deps.sessionTabsRef.current.find((candidate) => candidate.id === anchorTabId)
    if (!anchor) {
      return []
    }
    return BULK_TAB_CLOSE_ACTIONS.filter(
      ({ mode }) => selectClosable(anchor.id, mode).length > 0
    ).map(({ mode, label }) => ({
      label,
      destructive: true,
      onPress: () => {
        dismiss()
        void bulkClose(anchor, mode)
      }
    }))
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
