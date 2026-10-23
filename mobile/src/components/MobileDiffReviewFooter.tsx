import { View } from 'react-native'
import { Check, ChevronLeft, ChevronRight, MessageSquarePlus, Send } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { MobileDiffReviewQueueItem } from '../session/mobile-diff-review-queue'
import type { GitMutationMethod } from '../session/mobile-diff-review-screen-model'
import { colors, spacing } from '../theme/mobile-theme'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'

type Props = {
  busyAction: string | null
  item: MobileDiffReviewQueueItem
  /** Notes not yet sent to an agent; once there are any, sending them is the screen's primary. */
  unsentCount?: number
  onAddFileNote: () => void
  /** Stage, unstage and discard live in the review actions sheet; kept for callers that pass them. */
  onDiscard?: (item: MobileDiffReviewQueueItem) => void
  onGitMutation?: (method: GitMutationMethod, item: MobileDiffReviewQueueItem) => void
  onMarkReviewed: () => void
  onMoveFile: (direction: 'next' | 'previous') => void
  onSendNotes?: () => void
}

/** One toolbar: previous and next file, a file note, reviewed, and Send once there are notes. */
export function MobileDiffReviewFooter({
  item,
  unsentCount = 0,
  onAddFileNote,
  onMarkReviewed,
  onMoveFile,
  onSendNotes
}: Props) {
  const insets = useSafeAreaInsets()
  const sending = unsentCount > 0 && onSendNotes !== undefined
  return (
    <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.xs }]}>
      <IconButton
        icon={ChevronLeft}
        accessibilityLabel="Previous file"
        onPress={() => onMoveFile('previous')}
        variant="bare"
      />
      <IconButton
        icon={MessageSquarePlus}
        accessibilityLabel="Add file note"
        onPress={onAddFileNote}
        variant="bare"
      />
      <View style={styles.footerSpacer} />
      {sending ? (
        <>
          <IconButton
            icon={Check}
            accessibilityLabel="Mark file reviewed"
            onPress={onMarkReviewed}
            selected={item.isReviewed}
            iconColor={item.isReviewed ? colors.statusGreen : undefined}
          />
          <Button
            label={`Send ${unsentCount === 1 ? '1 note' : `${unsentCount} notes`}`}
            icon={Send}
            variant="primary"
            size="compact"
            onPress={onSendNotes}
            accessibilityLabel="Send notes to agent"
          />
        </>
      ) : (
        <Button
          label={item.isReviewed ? 'Reviewed' : 'Mark reviewed'}
          icon={Check}
          variant={item.isReviewed ? 'secondary' : 'primary'}
          size="compact"
          onPress={onMarkReviewed}
          accessibilityLabel="Mark file reviewed"
        />
      )}
      <IconButton
        icon={ChevronRight}
        accessibilityLabel="Next file"
        onPress={() => onMoveFile('next')}
        variant="bare"
      />
    </View>
  )
}
