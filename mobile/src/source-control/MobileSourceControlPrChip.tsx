import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleDot,
  GitPullRequest,
  MessageSquare,
  X
} from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { statusColor } from '../components/pr-sidebar/pr-sidebar-status-color'
import { hubStyles } from './mobile-source-control-hub-styles'
import type { MobilePrChipRollup, MobilePrChipSummary } from './mobile-pr-chip-summary'

type Props = {
  summary: MobilePrChipSummary
  onPress: () => void
}

// The glanceable PR status line on the branch card. Tapping it switches to the
// Pull Request segment. Rendered only when the repo supports hosted review — the
// parent gates on that, so this component always has something meaningful to show.
export function MobileSourceControlPrChip({ summary, onPress }: Props) {
  return (
    <Pressable
      style={({ pressed }) => [hubStyles.chip, pressed && hubStyles.chipPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={chipAccessibilityLabel(summary)}
    >
      <View style={hubStyles.chipIcon}>
        <GitPullRequest size={15} color={colors.textSecondary} strokeWidth={2.1} />
      </View>
      {summary.kind === 'loading' ? (
        <>
          <ActivityIndicator size="small" color={colors.textSecondary} />
          <Text style={hubStyles.chipMutedText} numberOfLines={1}>
            Loading pull request…
          </Text>
        </>
      ) : summary.kind === 'none' ? (
        <>
          <Text style={hubStyles.chipCreateText}>Create pull request</Text>
          <View style={hubStyles.chipSpacer} />
          <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.1} />
        </>
      ) : summary.kind === 'unavailable' ? (
        <>
          <Text style={hubStyles.chipMutedText} numberOfLines={1}>
            {summary.message}
          </Text>
          <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.1} />
        </>
      ) : (
        <>
          <Text style={hubStyles.chipNumber}>#{summary.number}</Text>
          <View style={[hubStyles.statePill, { borderColor: statusColor(summary.stateToken) }]}>
            <Text style={[hubStyles.statePillText, { color: statusColor(summary.stateToken) }]}>
              {summary.stateLabel}
            </Text>
          </View>
          <ChipRollup rollup={summary.rollup} />
          {summary.commentCount != null && summary.commentCount > 0 ? (
            <View style={hubStyles.comment}>
              <MessageSquare size={13} color={colors.textSecondary} strokeWidth={2.1} />
              <Text style={hubStyles.commentText}>{summary.commentCount}</Text>
            </View>
          ) : null}
          <View style={hubStyles.chipSpacer} />
          <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.1} />
        </>
      )}
    </Pressable>
  )
}

function ChipRollup({ rollup }: { rollup: MobilePrChipRollup }) {
  const color = statusColor(rollup.token)
  return (
    <View style={hubStyles.rollup}>
      <RollupIcon kind={rollup.kind} color={color} />
      <Text style={[hubStyles.rollupText, { color }]}>{rollup.text}</Text>
    </View>
  )
}

function RollupIcon({ kind, color }: { kind: MobilePrChipRollup['kind']; color: string }) {
  const size = 13
  const strokeWidth = 2.3
  switch (kind) {
    case 'conflict':
      return <AlertTriangle size={size} color={color} strokeWidth={strokeWidth} />
    case 'failing':
      return <X size={size} color={color} strokeWidth={strokeWidth} />
    case 'running':
      return <CircleDot size={size} color={color} strokeWidth={strokeWidth} />
    case 'passed':
      return <Check size={size} color={color} strokeWidth={strokeWidth} />
    case 'none':
      return null
  }
}

function chipAccessibilityLabel(summary: MobilePrChipSummary): string {
  switch (summary.kind) {
    case 'loading':
      return 'Loading pull request'
    case 'none':
      return 'Create pull request'
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
