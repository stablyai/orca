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
import { useTranslate } from '../i18n/useTranslate'
import { colors, spacing } from '../theme/mobile-theme'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'

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
  const { t } = useTranslate()
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
            accessibilityLabel={t('mobile.diffFooter.stageA11y', 'Stage file')}
          >
            <Plus size={14} color={colors.textSecondary} strokeWidth={2.2} />
            <Text style={styles.secondaryButtonText}>{t('mobile.diffFooter.stage', 'Stage')}</Text>
          </Pressable>
        ) : null}
        {item.canUnstage ? (
          <Pressable
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
            disabled={busyAction !== null}
            onPress={() => onGitMutation('git.unstage', item)}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.diffFooter.unstageA11y', 'Unstage file')}
          >
            <Undo2 size={14} color={colors.textSecondary} strokeWidth={2.2} />
            <Text style={styles.secondaryButtonText}>
              {t('mobile.diffFooter.unstage', 'Unstage')}
            </Text>
          </Pressable>
        ) : null}
        {item.canDiscard ? (
          <Pressable
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
            disabled={busyAction !== null}
            onPress={() => onDiscard(item)}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.diffFooter.discardA11y', 'Discard file')}
          >
            <Trash2 size={14} color={colors.statusRed} strokeWidth={2.2} />
            <Text style={styles.destructiveText}>{t('mobile.diffFooter.discard', 'Discard')}</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.footerRow}>
        <Pressable
          style={({ pressed }) => [styles.navButton, pressed && styles.buttonPressed]}
          onPress={() => onMoveFile('previous')}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.diffFooter.previousFile', 'Previous file')}
        >
          <ChevronLeft size={17} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.footerButton, pressed && styles.buttonPressed]}
          onPress={onAddFileNote}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.diffFooter.addFileNoteA11y', 'Add file note')}
        >
          <FileText size={14} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.footerButtonText}>{t('mobile.diffFooter.note', 'Note')}</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.primaryButton,
            item.isReviewed && styles.primaryButtonDone,
            pressed && styles.buttonPressed
          ]}
          onPress={onMarkReviewed}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.diffFooter.markReviewedA11y', 'Mark file reviewed')}
        >
          <Check size={14} color={colors.bgBase} strokeWidth={2.2} />
          <Text style={styles.primaryButtonText}>
            {item.isReviewed
              ? t('mobile.diffFooter.reviewed', 'Reviewed')
              : t('mobile.diffFooter.markReviewed', 'Mark Reviewed')}
          </Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.navButton, pressed && styles.buttonPressed]}
          onPress={() => onMoveFile('next')}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.diffFooter.nextFile', 'Next file')}
        >
          <ChevronRight size={17} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
      </View>
    </View>
  )
}
