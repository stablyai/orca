import type { PrSidebarState } from '../session/mobile-pr-sidebar-state'

// Keep sidebar decisions pure and RN-free for Node tests.

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

// Dock only when measured wide row preserves usable main column; otherwise overlay.
export function resolvePresentationMode(
  isWideLayout: boolean,
  canDock = isWideLayout
): PrSidebarPresentationMode {
  return isWideLayout && canDock ? 'inline' : 'overlay'
}

// Show PR trigger only in overlay mode, on any GitHub repo; no-PR branches open create/empty state instead of hiding entry point.
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
