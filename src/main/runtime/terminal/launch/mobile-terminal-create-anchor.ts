import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { RuntimeMobileSessionSnapshotTab } from '../../../../shared/runtime-mobile-session-tab-contracts'

/** Reject unknown named anchors; absent anchors and clients without split-group placement append. */
export function anchorTabOfCreate(
  rows: readonly RuntimeMobileSessionSnapshotTab[] | undefined,
  requestedAfterTabId: string | undefined,
  placesAfterAnchor: boolean
): string | undefined {
  if (!requestedAfterTabId) {
    return undefined
  }
  const anchor = rows?.find((tab) => tab.id === requestedAfterTabId)
  if (!anchor) {
    throw new Error('after_tab_not_found')
  }
  if (!placesAfterAnchor) {
    return undefined
  }
  return anchor.type === 'terminal' ? anchor.parentTabId : anchor.id
}

/** For main-owned placement, translate chat/browser row ids to their held tab so main can find the anchor group. */
export function mainPlacedAfter(
  heldTabId: () => string | undefined,
  afterDesktopTabId: string | undefined
): { afterDesktopTabId?: string } {
  // Read main's layout only when its answer is used: never switch-off, nor for an appending phone.
  return ORCA_LAYOUT_OWNER_IS_MAIN && afterDesktopTabId
    ? { afterDesktopTabId: heldTabId() ?? afterDesktopTabId }
    : {}
}
