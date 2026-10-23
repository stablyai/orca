import { ActivityIndicator } from 'react-native'
import { AlertTriangle, Check, CircleDot, GitPullRequest, X } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { Badge, type BadgeTone } from '../components/ui/Badge'
import { ListGroup } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import type { MobileStatusToken } from '../components/pr-sidebar/pr-checks-presentation'
import type { MobilePrChipRollup, MobilePrChipSummary } from './mobile-pr-chip-summary'
import { hubStyles } from './mobile-source-control-hub-styles'

type Props = {
  summary: MobilePrChipSummary
  onPress: () => void
}

const TONE: Record<MobileStatusToken, BadgeTone> = {
  statusGreen: 'green',
  statusAmber: 'amber',
  statusRed: 'red',
  statusPurple: 'purple',
  textSecondary: 'neutral'
}

const ROLLUP_ICON = {
  conflict: AlertTriangle,
  failing: X,
  running: CircleDot,
  passed: Check,
  none: undefined
} as const satisfies Record<MobilePrChipRollup['kind'], unknown>

// The glanceable PR status row under the branch header. Tapping it switches to the
// Pull Request segment. Rendered only when the repo supports hosted review — the
// parent gates on that, so this component always has something meaningful to show.
export function MobileSourceControlPrChip({ summary, onPress }: Props) {
  const label = chipAccessibilityLabel(summary)
  return (
    <ListGroup style={hubStyles.prGroup}>
      {summary.kind === 'loading' ? (
        <ListRow
          title="Loading pull request…"
          leading={<ActivityIndicator size="small" color={colors.textSecondary} />}
          onPress={onPress}
          accessibilityLabel={label}
        />
      ) : summary.kind === 'none' ? (
        <ListRow
          title="No pull request"
          leading={<GitPullRequest size={18} color={colors.textMuted} strokeWidth={2.1} />}
          navigates
          onPress={onPress}
          accessibilityLabel={label}
        />
      ) : summary.kind === 'unavailable' ? (
        <ListRow
          title="Pull request"
          subtitle={summary.message}
          leading={<GitPullRequest size={18} color={colors.textMuted} strokeWidth={2.1} />}
          navigates
          onPress={onPress}
          accessibilityLabel={label}
        />
      ) : (
        <ListRow
          title={`#${summary.number}`}
          leading={<GitPullRequest size={18} color={colors.textSecondary} strokeWidth={2.1} />}
          accessory={
            <>
              <Badge label={summary.stateLabel} tone={TONE[summary.stateToken]} />
              {summary.rollup.kind === 'none' ? null : (
                <Badge
                  label={summary.rollup.text}
                  tone={TONE[summary.rollup.token]}
                  icon={ROLLUP_ICON[summary.rollup.kind]}
                />
              )}
              {summary.commentCount != null && summary.commentCount > 0 ? (
                <Badge label={`${summary.commentCount} open`} />
              ) : null}
            </>
          }
          navigates
          onPress={onPress}
          accessibilityLabel={label}
        />
      )}
    </ListGroup>
  )
}

function chipAccessibilityLabel(summary: MobilePrChipSummary): string {
  switch (summary.kind) {
    case 'loading':
      return 'Loading pull request'
    case 'none':
      return 'No pull request. Opens the pull request tab'
    case 'unavailable':
      return `Pull request unavailable: ${summary.message}`
    case 'ready': {
      const comments =
        summary.commentCount != null && summary.commentCount > 0
          ? `, ${summary.commentCount} unresolved comments`
          : ''
      return `Pull request #${summary.number}, ${summary.stateLabel}, ${summary.rollup.text}${comments}. Open pull request.`
    }
  }
}
