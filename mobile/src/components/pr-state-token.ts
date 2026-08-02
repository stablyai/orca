import type { MobileStatusToken } from './pr-sidebar/pr-checks-presentation'

// Single source of truth for mapping a hosted-review PR state to a status-color
// token, shared by the workspace-list linked-PR badge (WorktreeMetaGlyphs) and
// the PR sidebar's state badge (PRSidebarHeader) so the two can't drift.
//
// Palette mirrors the desktop ReviewIcon (worktree-review-helpers.tsx): merged =
// purple, open = green, closed = red, draft/unknown = muted. Provider-agnostic —
// these are generic hosted-review states (GitHub PR, GitLab MR, etc.), accepted
// as a free-form string since the list payload carries a raw state.
export function prStateToken(state: string): MobileStatusToken {
  switch (state.toLowerCase()) {
    case 'merged':
      return 'statusPurple'
    case 'open':
      return 'statusGreen'
    case 'closed':
      return 'statusRed'
    default:
      return 'textSecondary'
  }
}
