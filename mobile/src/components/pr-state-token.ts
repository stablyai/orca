import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon
} from 'lucide-react-native'
import type { MobileStatusToken } from './pr-sidebar/pr-checks-presentation'

// Share status tokens between workspace PR badge and sidebar to prevent color drift, matching desktop ReviewIcon.
// Accept raw generic hosted-review strings across providers: merged purple, open green, closed red, draft/unknown muted.
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

// Glyph per state, like GitHub and desktop's getReviewStateIcon; open and unknown keep the plain PR glyph.
export function prStateIcon(state: string): LucideIcon {
  switch (state.toLowerCase()) {
    case 'merged':
      return GitMerge
    case 'closed':
      return GitPullRequestClosed
    case 'draft':
      return GitPullRequestDraft
    default:
      return GitPullRequest
  }
}
