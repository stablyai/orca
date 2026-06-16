import { SafeAreaView } from 'react-native-safe-area-context'
import { Text, View } from 'react-native'
import type { useMobileDiffReviewController } from '../session/use-mobile-diff-review-controller'
import { MobileDiffReviewBody } from './MobileDiffReviewBody'
import { MobileDiffReviewDrawers } from './MobileDiffReviewDrawers'
import { MobileDiffReviewFileSummary } from './MobileDiffReviewFileSummary'
import { MobileDiffReviewFooter } from './MobileDiffReviewFooter'
import { MobileDiffReviewHeader } from './MobileDiffReviewHeader'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'

type Props = {
  controller: ReturnType<typeof useMobileDiffReviewController>
  onBack: () => void
}

export function MobileDiffReviewScreenView({ controller, onBack }: Props) {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <MobileDiffReviewHeader
        filter={controller.filter}
        queueLength={controller.queue.length}
        reviewedCount={controller.reviewedCount}
        unsentCount={controller.unsentComments.length}
        worktreeLabel={controller.worktreeLabel}
        onBack={onBack}
        onOpenActions={() => controller.setShowOverflow(true)}
        onSelectFilter={controller.selectFilter}
      />
      {controller.currentItem ? (
        <MobileDiffReviewFileSummary
          currentIndex={controller.currentIndex}
          diffState={controller.diffState}
          fileNotes={controller.fileNotes}
          filteredCount={controller.filteredQueue.length}
          item={controller.currentItem}
          staleCommentIds={controller.staleCommentIds}
          onEditNote={controller.openEditComposer}
          onJumpHunk={controller.jumpHunk}
        />
      ) : null}
      {controller.actionError ? (
        <View style={styles.actionError}>
          <Text style={styles.actionErrorText}>{controller.actionError}</Text>
        </View>
      ) : null}
      <MobileDiffReviewBody
        activeHunkIndex={controller.activeHunkIndex}
        commentsByLine={controller.commentsByLine}
        currentItem={controller.currentItem}
        diffState={controller.diffState}
        filteredCount={controller.filteredQueue.length}
        listRef={controller.listRef}
        screenState={controller.screenState}
        staleCommentIds={controller.staleCommentIds}
        onAddNote={controller.openComposer}
        onEditNote={controller.openEditComposer}
        onRetry={controller.retryAction}
      />
      {controller.currentItem ? (
        <MobileDiffReviewFooter
          busyAction={controller.busyAction}
          item={controller.currentItem}
          onAddFileNote={() => controller.openComposer(0)}
          onDiscard={controller.setDiscardTarget}
          onGitMutation={(method, item) => void controller.runGitMutation(method, item)}
          onMarkReviewed={() => void controller.markReviewed()}
          onMoveFile={controller.moveFile}
        />
      ) : null}
      <MobileDiffReviewDrawers controller={controller} />
    </SafeAreaView>
  )
}
