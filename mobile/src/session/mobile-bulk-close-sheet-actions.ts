import type { MarkdownDocState, MobileSessionTab } from './mobile-session-route-types'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { selectBulkCloseTabs } from './mobile-tab-close-selection'
import { closeTabsAfterConfirmation } from '../../../src/shared/bulk-tab-close-confirmation'
import { translate } from '../i18n/mobile-i18n'

type BulkCloseSheetDeps = {
  sessionTabsRef: { readonly current: readonly MobileSessionTab[] }
  markdownDocs: ReadonlyMap<string, MarkdownDocState>
  activeSessionTabIdRef: { readonly current: string | null }
  switchSessionTab: (tab: MobileSessionTab) => void
  closeSessionTab: (tab: MobileSessionTab) => Promise<void>
  confirmBulkClose: () => Promise<boolean>
}

// Pass tab ids so long-press sheets share bulk-close orchestration without retaining full tabs.
export function createBulkCloseSheetActions(deps: BulkCloseSheetDeps) {
  const selectClosable = (anchorTabId: string) =>
    selectBulkCloseTabs(deps.sessionTabsRef.current, anchorTabId).filter((candidate) => {
      if (candidate.type !== 'markdown') {
        return true
      }
      // Why: the tab list's isDirty can lag behind a phone draft; the local
      // markdown doc state is the authority on unsaved edits.
      const doc = deps.markdownDocs.get(candidate.id)
      return !(doc?.status === 'ready' && doc.isDirty)
    })

  const bulkClose = async (anchor: MobileSessionTab, tabIds: readonly string[]) => {
    const targets = deps.sessionTabsRef.current.filter((candidate) => tabIds.includes(candidate.id))
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

  return (anchorTabId: string | null | undefined): ActionSheetAction[] => {
    const anchor =
      anchorTabId == null
        ? undefined
        : deps.sessionTabsRef.current.find((candidate) => candidate.id === anchorTabId)
    if (!anchor || selectClosable(anchor.id).length === 0) {
      return []
    }
    return [
      {
        id: 'closeOtherTabs',
        label: translate('session.bulkCloseSheetActions.closeOtherTabs', 'Close Other Tabs'),
        destructive: true,
        // Why: the confirm is its own native Modal; wait for this sheet to unmount (#10331).
        closeBeforePress: true,
        onPress: () => {
          void closeTabsAfterConfirmation(
            () => selectClosable(anchor.id).map((candidate) => candidate.id),
            deps.confirmBulkClose,
            (tabIds) => void bulkClose(anchor, tabIds)
          )
        }
      }
    ]
  }
}

export function createCloseWithBulkActions(
  closeSessionTab: (tab: MobileSessionTab) => Promise<void>,
  bulkActions: ReturnType<typeof createBulkCloseSheetActions>
) {
  return (target: MobileSessionTab | null, dismiss: () => void): ActionSheetAction[] => [
    {
      id: 'close',
      label: translate('common.close', 'Close'),
      destructive: true,
      onPress: () => {
        dismiss()
        if (target) {
          void closeSessionTab(target)
        }
      }
    },
    ...bulkActions(target?.id)
  ]
}
