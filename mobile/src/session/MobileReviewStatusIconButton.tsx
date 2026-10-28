import { memo } from 'react'
import {
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft
} from 'lucide-react-native'
import type {
  ReviewStatusGlyph,
  ReviewStatusTone,
  ReviewStatusPresentation
} from '../../../src/shared/review-status-presentation'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MobileSessionHeaderIconButton } from './MobileSessionHeaderIconButton'

const glyphs = {
  branch: GitBranch,
  'pull-request': GitPullRequest,
  merge: GitMerge,
  draft: GitPullRequestDraft,
  closed: GitPullRequestClosed
} satisfies Record<ReviewStatusGlyph, typeof GitBranch>

const toneColors = {
  neutral: 'textSecondary',
  open: 'statusGreen',
  success: 'statusGreen',
  failure: 'statusRed',
  pending: 'statusAmber',
  merged: 'statusPurple',
  draft: 'textMuted',
  closed: 'textMuted'
} as const satisfies Record<ReviewStatusTone, keyof typeof colors>

export const MobileReviewStatusIconButton = memo(function MobileReviewStatusIconButton({
  presentation,
  active,
  onPress
}: {
  presentation: ReviewStatusPresentation
  active: boolean
  onPress: () => void
}) {
  useMobileColorScheme()
  return (
    <MobileSessionHeaderIconButton
      active={active}
      accessibilityLabel={`Open source control, ${presentation.label}`}
      icon={glyphs[presentation.glyph]}
      iconColor={colors[toneColors[presentation.tone]]}
      onPress={onPress}
    />
  )
})
