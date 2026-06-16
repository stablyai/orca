import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Text, View } from 'react-native'
import type { useMobileDiffReviewController } from '../session/use-mobile-diff-review-controller'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { MobileDiffReviewBody } from './MobileDiffReviewBody'
import { MobileDiffReviewDrawers } from './MobileDiffReviewDrawers'
import { MobileDiffReviewFileSummary } from './MobileDiffReviewFileSummary'
import { MobileDiffReviewFooter } from './MobileDiffReviewFooter'
import { MobileDiffReviewHeader } from './MobileDiffReviewHeader'
import { MobilePRSidebar } from './MobilePRSidebar'
import { RightDrawer } from './RightDrawer'
import { mobilePrSidebarStyles } from './pr-sidebar/mobile-pr-sidebar-styles'
import { resolvePresentationMode } from './mobile-pr-sidebar-presentation'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'

type Props = {
  controller: ReturnType<typeof useMobileDiffReviewController>
  onBack: () => void
}

export function MobileDiffReviewScreenView({ controller, onBack }: Props) {
  const { isWideLayout } = useResponsiveLayout()
  const insets = useSafeAreaInsets()
  const presentationMode = resolvePresentationMode(isWideLayout)
  // Inline-dock the sidebar only when wide and a PR is eligible; otherwise it lives
  // in the RightDrawer overlay toggled by showPRSidebar.
  const showInlineDock = presentationMode === 'inline' && controller.prSidebarEligible

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <MobileDiffReviewHeader
        filter={controller.filter}
        isWideLayout={isWideLayout}
        prSidebarEligible={controller.prSidebarEligible}
        queueLength={controller.queue.length}
        reviewedCount={controller.reviewedCount}
        unsentCount={controller.unsentComments.length}
        worktreeLabel={controller.worktreeLabel}
        onBack={onBack}
        onOpenActions={() => controller.setShowOverflow(true)}
        onOpenPRSidebar={controller.openPRSidebar}
        onSelectFilter={controller.selectFilter}
      />
      <View style={{ flex: 1, flexDirection: 'row' }}>
        {/* Diff column keeps its full layout; in wide mode the docked sidebar sits
            beside it and each column scrolls independently. */}
        <View style={{ flex: 1, minWidth: 0 }}>
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
        </View>
        {showInlineDock ? (
          <View style={mobilePrSidebarStyles.dockColumn}>
            <MobilePRSidebar
              state={controller.prSidebarState}
              onRetry={controller.retryPRSidebar}
              refetch={controller.refetchPRSidebar}
              client={controller.client}
              connState={controller.connState}
              worktreeId={controller.worktreeId}
              headSha={controller.prSidebarHeadSha}
              bottomInset={insets.bottom}
            />
          </View>
        ) : null}
      </View>
      <MobileDiffReviewDrawers controller={controller} />
      {presentationMode === 'overlay' ? (
        <RightDrawer
          visible={controller.showPRSidebar}
          onClose={() => controller.setShowPRSidebar(false)}
        >
          <MobilePRSidebar
            state={controller.prSidebarState}
            onRetry={controller.retryPRSidebar}
            refetch={controller.refetchPRSidebar}
            client={controller.client}
            connState={controller.connState}
            worktreeId={controller.worktreeId}
            headSha={controller.prSidebarHeadSha}
          />
        </RightDrawer>
      ) : null}
    </SafeAreaView>
  )
}
