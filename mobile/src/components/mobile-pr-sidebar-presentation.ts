import type { PrSidebarState } from '../session/mobile-pr-sidebar-state'

// Pure presentation helpers for the mobile PR sidebar. No React/native imports so
// the responsive + render-branch decisions are unit-testable under node Vitest.

export type PrSidebarPresentationMode = 'inline' | 'overlay'

// Wide layouts dock the sidebar inline beside the diff; narrow layouts slide it in
// as an overlay drawer. Reuses the existing 700px breakpoint (KTD2) via isWideLayout.
export function resolvePresentationMode(isWideLayout: boolean): PrSidebarPresentationMode {
  return isWideLayout ? 'inline' : 'overlay'
}

// The header trigger is only meaningful in overlay mode: in wide/docked mode the
// sidebar is always visible, so the trigger is hidden (not disabled). It also never
// shows when the PR is ineligible (non-GitHub / no linked PR).
export function shouldShowTrigger(args: {
  prSidebarEligible: boolean
  isWideLayout: boolean
}): boolean {
  return args.prSidebarEligible && !args.isWideLayout
}

export type PrSidebarRenderBranch = 'loading' | 'error' | 'blocked' | 'ready' | 'hidden'

// Maps the controller's state machine to a render branch the shell switches on.
export function prSidebarRenderBranch(state: PrSidebarState): PrSidebarRenderBranch {
  return state.kind
}
