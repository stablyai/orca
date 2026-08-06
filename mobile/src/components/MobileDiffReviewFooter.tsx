import { Pressable, Text, View } from 'react-native'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  Plus,
  Trash2,
  Undo2
} from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { MobileDiffReviewQueueItem } from '../session/mobile-diff-review-queue'
import type { GitMutationMethod } from '../session/mobile-diff-review-screen-model'
import { colors, spacing } from '../theme/mobile-theme'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'
import { t } from '@/i18n/mobile-i18n'

type Props = {
  busyAction: string | null
  item: MobileDiffReviewQueueItem
  onAddFileNote: () => void
  onDiscard: (item: MobileDiffReviewQueueItem) => void
  onGitMutation: (method: GitMutationMethod, item: MobileDiffReviewQueueItem) => void
  onMarkReviewed: () => void
  onMoveFile: (direction: 'next' | 'previous') => void
}

export function MobileDiffReviewFooter({
  busyAction,
  item,
  onAddFileNote,
  onDiscard,
  onGitMutation,
  onMarkReviewed,
  onMoveFile
}: Props) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.sm }]}>
      <View style={styles.fileActionRow}>
        {item.canStage ? (
          <Pressable
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
            disabled={busyAction !== null}
            onPress={() => onGitMutation('git.stage', item)}
            accessibilityRole="button"
            accessibilityLabel={t('mobileDiffReviewFooter.stageFile')}
          >
            <Plus size={14} color={colors.textSecondary} strokeWidth={2.2} />
            <Text style={styles.secondaryButtonText}>{t('mobileDiffReviewFooter.stage')}</Text>
          </Pressable>
        ) : null}
        {item.canUnstage ? (
          <Pressable
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
            disabled={busyAction !== null}
            onPress={() => onGitMutation('git.unstage', item)}
            accessibilityRole="button"
            accessibilityLabel={t('mobileDiffReviewFooter.unstageFile')}
          >
            <Undo2 size={14} color={colors.textSecondary} strokeWidth={2.2} />
            <Text style={styles.secondaryButtonText}>{t('mobileDiffReviewFooter.unstage')}</Text>
          </Pressable>
        ) : null}
        {item.canDiscard ? (
          <Pressable
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
            disabled={busyAction !== null}
            onPress={() => onDiscard(item)}
            accessibilityRole="button"
            accessibilityLabel={t('mobileDiffReviewFooter.discardFile')}
          >
            <Trash2 size={14} color={colors.statusRed} strokeWidth={2.2} />
            <Text style={styles.destructiveText}>{t('mobileDiffReviewFooter.discard')}</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.footerRow}>
        <Pressable
          style={({ pressed }) => [styles.navButton, pressed && styles.buttonPressed]}
          onPress={() => onMoveFile('previous')}
          accessibilityRole="button"
          accessibilityLabel={t('mobileDiffReviewFooter.previous')}
        >
          <ChevronLeft size={17} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.footerButton, pressed && styles.buttonPressed]}
          onPress={onAddFileNote}
          accessibilityRole="button"
          accessibilityLabel={t('mobileDiffReviewFooter.add')}
        >
          <FileText size={14} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.footerButtonText}>{t('mobileDiffReviewFooter.note')}</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.primaryButton,
            item.isReviewed && styles.primaryButtonDone,
            pressed && styles.buttonPressed
          ]}
          onPress={onMarkReviewed}
          accessibilityRole="button"
          accessibilityLabel={t('mobileDiffReviewFooter.markFile')}
        >
          <Check size={14} color={colors.bgBase} strokeWidth={2.2} />
          <Text style={styles.primaryButtonText}>
            {item.isReviewed
              ? t('mobileDiffReviewFooter.reviewed')
              : t('mobileDiffReviewFooter.markReviewed')}
          </Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.navButton, pressed && styles.buttonPressed]}
          onPress={() => onMoveFile('next')}
          accessibilityRole="button"
          accessibilityLabel={t('mobileDiffReviewFooter.next')}
        >
          <ChevronRight size={17} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
      </View>
    </View>
  )
}
