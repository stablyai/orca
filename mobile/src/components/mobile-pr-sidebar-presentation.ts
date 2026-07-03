import type { PrSidebarState } from '../session/mobile-pr-sidebar-state'

// Pure presentation helpers for the mobile PR sidebar. No React/native imports so
// the responsive + render-branch decisions are unit-testable under node Vitest.

export type PrSidebarPresentationMode = 'inline' | 'overlay'

export const PR_SIDEBAR_MIN_MAIN_WIDTH = 360

export function canDockPrSidebar(args: {
  isWideLayout: boolean
  availableWidth: number
  dockWidth: number
  minMainWidth?: number
}): boolean {
  return (
    args.isWideLayout &&
    args.availableWidth >= args.dockWidth + (args.minMainWidth ?? PR_SIDEBAR_MIN_MAIN_WIDTH)
  )
}

// Wide layouts dock the sidebar inline beside the diff only when the measured
// row can preserve a usable main column; otherwise it falls back to the overlay.
export function resolvePresentationMode(
  isWideLayout: boolean,
  canDock = isWideLayout
): PrSidebarPresentationMode {
  return isWideLayout && canDock ? 'inline' : 'overlay'
}

// The header trigger is only meaningful in overlay mode: in wide/docked mode the
// sidebar is always visible, so the trigger is hidden (not disabled). The dedicated
// PR icon shows on any GitHub repo regardless of whether a PR is linked — a no-PR
// branch opens to an empty state rather than hiding the entry point.
export function shouldShowTrigger(args: {
  isGithubRepo: boolean
  isWideLayout: boolean
  canDock?: boolean
}): boolean {
  const isDocked = args.isWideLayout && (args.canDock ?? args.isWideLayout)
  return args.isGithubRepo && !isDocked
}

export type PrSidebarRenderBranch = 'loading' | 'error' | 'blocked' | 'ready' | 'none' | 'hidden'

// Maps the controller's state machine to a render branch the shell switches on.
export function prSidebarRenderBranch(state: PrSidebarState): PrSidebarRenderBranch {
  return state.kind
}
