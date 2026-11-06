import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Check, ChevronLeft, ChevronRight, Plus } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileDiffReviewQueueItem } from '../session/mobile-diff-review-queue'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'
import { canMarkMobileDiffReviewItemViewed } from './MobileDiffReviewFileSummary'

type Props = {
  busyAction: string | null
  item: MobileDiffReviewQueueItem
  onMarkViewed: () => void
  onStageAndOpenNext: () => void
  onMoveFile: (direction: 'next' | 'previous') => void
}

export function MobileDiffReviewFooter({
  busyAction,
  item,
  onMarkViewed,
  onStageAndOpenNext,
  onMoveFile
}: Props) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const insets = useSafeAreaInsets()
  // A conflicted or submodule-only change can't be staged here, so it just moves on.
  const stages = item.scope === 'unstaged' && item.canStage
  const busy = busyAction !== null
  const primary = stages
    ? {
        icon: Plus,
        label: t('components.diffReviewFooter.stageNext', 'Stage · next file'),
        disabled: busy,
        onPress: onStageAndOpenNext
      }
    : item.isReviewed || !canMarkMobileDiffReviewItemViewed(item)
      ? {
          icon: ChevronRight,
          label: t('components.diffReviewFooter.nextFile', 'Next file'),
          disabled: false,
          onPress: () => onMoveFile('next')
        }
      : {
          icon: Check,
          label: t('components.diffReviewFooter.viewedNext', 'Viewed · next file'),
          disabled: false,
          onPress: onMarkViewed
        }
  const PrimaryIcon = primary.icon
  return (
    <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.sm }]}>
      <View style={styles.footerRow}>
        <Pressable
          style={({ pressed }) => [styles.navButton, pressed && styles.buttonPressed]}
          onPress={() => onMoveFile('previous')}
          accessibilityRole="button"
          accessibilityLabel={t('components.diffReviewFooter.previousFile', 'Previous file')}
        >
          <ChevronLeft size={20} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.primaryButton,
            primary.disabled && styles.buttonDisabled,
            pressed && styles.buttonPressed
          ]}
          disabled={primary.disabled}
          onPress={primary.onPress}
          accessibilityRole="button"
          accessibilityLabel={primary.label}
          accessibilityState={{ disabled: primary.disabled, busy }}
        >
          {busy && stages ? (
            <ActivityIndicator size="small" color={colors.bgBase} />
          ) : (
            <>
              <PrimaryIcon size={17} color={colors.bgBase} strokeWidth={2.2} />
              <Text style={styles.primaryButtonText} numberOfLines={1}>
                {primary.label}
              </Text>
            </>
          )}
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.navButton, pressed && styles.buttonPressed]}
          onPress={() => onMoveFile('next')}
          accessibilityRole="button"
          accessibilityLabel={t('components.diffReviewFooter.nextFileButton', 'Next file')}
        >
          <ChevronRight size={20} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
      </View>
    </View>
  )
}
