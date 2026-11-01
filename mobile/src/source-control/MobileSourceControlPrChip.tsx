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
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { statusColor } from '../components/pr-sidebar/pr-sidebar-status-color'
import { hubStyles } from './mobile-source-control-hub-styles'
import type { MobilePrChipRollup, MobilePrChipSummary } from './mobile-pr-chip-summary'

type Props = {
  summary: MobilePrChipSummary
  onPress: () => void
}

export function MobileSourceControlPrChip({ summary, onPress }: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <Pressable
      style={({ pressed }) => [hubStyles.chip, pressed && hubStyles.chipPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={chipAccessibilityLabel(summary, t)}
    >
      <View style={hubStyles.chipIcon}>
        <GitPullRequest size={15} color={colors.textSecondary} strokeWidth={2.1} />
      </View>
      {summary.kind === 'loading' ? (
        <>
          <ActivityIndicator size="small" color={colors.textSecondary} />
          <Text style={hubStyles.chipMutedText} numberOfLines={1}>
            {t('sourceControl.prChip.loading', 'Loading pull request…')}
          </Text>
        </>
      ) : summary.kind === 'none' ? (
        <>
          <Text style={hubStyles.chipCreateText}>
            {t('sourceControl.prChip.createPr', 'Create pull request')}
          </Text>
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
  useMobileColorScheme()
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

function chipAccessibilityLabel(summary: MobilePrChipSummary, t: Translate): string {
  switch (summary.kind) {
    case 'loading':
      return t('sourceControl.prChip.loadingLabel', 'Loading pull request')
    case 'none':
      return t('sourceControl.prChip.createPr', 'Create pull request')
    case 'unavailable':
      return t('sourceControl.prChip.unavailableLabel', 'Pull request unavailable: {{message}}', {
        message: summary.message
      })
    case 'ready': {
      const count = summary.commentCount
      const details = {
        number: summary.number,
        state: summary.stateLabel,
        checks: summary.rollup.text
      }
      if (count != null && count > 0) {
        return count === 1
          ? t(
              'sourceControl.prChip.openWithComments_one',
              'Pull request #{{number}}, {{state}}, {{checks}}, {{count}} unresolved comments. Open pull request.',
              { ...details, count }
            )
          : t(
              'sourceControl.prChip.openWithComments_other',
              'Pull request #{{number}}, {{state}}, {{checks}}, {{count}} unresolved comments. Open pull request.',
              { ...details, count }
            )
      }
      return t(
        'sourceControl.prChip.openLabel',
        'Pull request #{{number}}, {{state}}, {{checks}}. Open pull request.',
        details
      )
    }
  }
}
