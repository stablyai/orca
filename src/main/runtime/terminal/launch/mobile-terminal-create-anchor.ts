// The tab a phone's new terminal goes after: its anchor row's tab, where a split's panes share one.
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { RuntimeMobileSessionSnapshotTab } from '../../../../shared/runtime-mobile-session-tab-contracts'

/**
 * The anchor row's tab, or undefined when the create names no anchor or a client without
 * split-group placement asked (it appends). A named row the snapshot lacks is refused.
 */
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

/**
 * Layout-owner build: a windowless create hands main's layout the anchor, as a window's create
 * does, under main's own tab id when main holds the anchor row (a chat or browser row's id is not
 * that id), so main finds its group.
 */
export function mainPlacedAfter(
  heldTabId: () => string | undefined,
  afterDesktopTabId: string | undefined
): { afterDesktopTabId?: string } {
  // Read main's layout only when its answer is used: never switch-off, nor for an appending phone.
  return ORCA_LAYOUT_OWNER_IS_MAIN && afterDesktopTabId
    ? { afterDesktopTabId: heldTabId() ?? afterDesktopTabId }
    : {}
}
