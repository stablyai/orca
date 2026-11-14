import { useCallback, useEffect, useState } from 'react'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Text, View, type LayoutChangeEvent } from 'react-native'
import type { useMobileDiffReviewController } from '../use-mobile-diff-review-controller'
import { useResponsiveLayout } from '../../../layout/responsive-layout'
import { MobileDiffReviewBody } from './MobileDiffReviewBody'
import { useMobilePrCommentActions } from '../pull-request/comments/use-mobile-pr-comment-actions'
import { usePRCommentCardActions } from '../pull-request/comments/PRCommentsSection'
import { MobileDiffReviewDrawers } from './MobileDiffReviewDrawers'
import { MobileDiffReviewFileSummary } from './MobileDiffReviewFileSummary'
import { MobileDiffReviewFooter } from './MobileDiffReviewFooter'
import { MobileDiffReviewHeader } from './MobileDiffReviewHeader'
import { useMobileDiffReviewOverflowActions } from './use-mobile-diff-review-overflow-actions'
import { MobilePRSidebar } from '../pull-request/MobilePRSidebar'
import { RightDrawer } from '../../../components/RightDrawer'
import {
  mobilePrSidebarStyles,
  PR_SIDEBAR_DOCK_WIDTH
} from '../pull-request/mobile-pr-sidebar-styles'
import {
  canDockPrSidebar,
  resolvePresentationMode,
  shouldShowTrigger
} from '../pull-request/mobile-pr-sidebar-presentation'
import { mobileDiffReviewPositionLabel } from '../diff-state/mobile-diff-review-screen-model'
import { getRuntimePathBasename } from '../../../../../src/shared/cross-platform-path'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import type { HostConnectionInputs } from '../../../transport/connection/client-context-connection-metrics'

type Props = {
  controller: ReturnType<typeof useMobileDiffReviewController>
  hostConnection: HostConnectionInputs
  onBack: () => void
}

export function MobileDiffReviewScreenView({ controller, hostConnection, onBack }: Props) {
  useMobileColorScheme()
  const { isWideLayout } = useResponsiveLayout()
  const insets = useSafeAreaInsets()
  const [contentRowWidth, setContentRowWidth] = useState(0)
  const canDockSidebar = canDockPrSidebar({
    isWideLayout,
    availableWidth: contentRowWidth,
    dockWidth: PR_SIDEBAR_DOCK_WIDTH
  })
  const presentationMode = resolvePresentationMode(isWideLayout, canDockSidebar)
  // A docked sidebar needs no menu entry; phones reach the pull request from ⋯.
  const overflowActions = useMobileDiffReviewOverflowActions(controller, {
    showPullRequest: shouldShowTrigger({
      isGithubRepo: controller.prSidebarIsGithubRepo,
      isWideLayout,
      canDock: presentationMode === 'inline'
    })
  })
  const item = controller.currentItem
  const github = controller.github
  const threadCommentActions = useMobilePrCommentActions({
    hostId: controller.hostId,
    client: controller.client,
    connState: controller.connState,
    worktreeId: controller.worktreeId,
    prNumber: github?.prNumber ?? 0,
    prRepo: github?.prRepo ?? null,
    queries: controller.prQueries
  })
  const threadActions = usePRCommentCardActions(
    github ? threadCommentActions : undefined,
    github?.prRepo
  )
  const sheet = controller.sheet
  const selectedRange =
    sheet?.kind === 'range' ? { startLine: sheet.startLine, line: sheet.line } : null
  // Dock GitHub sidebar only when wide; otherwise showPRSidebar toggles RightDrawer overlay.
  const showInlineDock = presentationMode === 'inline' && controller.prSidebarIsGithubRepo
  const gitStatus = controller.screenState.kind === 'ready' ? controller.screenState.status : null

  // Load docked PR data on visibility; overlay loads on trigger press.
  const prSidebarKind = controller.prSidebarState.kind
  const loadPRSidebar = controller.refetchPRSidebar
  useEffect(() => {
    if (showInlineDock && prSidebarKind === 'hidden') {
      loadPRSidebar()
    }
  }, [showInlineDock, prSidebarKind, loadPRSidebar])

  const handleContentRowLayout = useCallback((event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width)
    setContentRowWidth((prev) => (prev === width ? prev : width))
  }, [])

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <MobileDiffReviewHeader
        actions={overflowActions}
        fileName={item ? getRuntimePathBasename(item.filePath) : null}
        subtitle={
          item
            ? mobileDiffReviewPositionLabel({
                scope: item.scope,
                position: controller.currentIndex + 1,
                count: controller.filteredQueue.length,
                viewedCount: controller.reviewedCount
              })
            : ''
        }
        onBack={onBack}
        onOpenFiles={() => controller.openSheet({ kind: 'files' })}
      />
      <View style={{ flex: 1, flexDirection: 'row' }} onLayout={handleContentRowLayout}>
        {/* Keep diff layout full; wide sidebar and diff scroll independently. */}
        <View style={{ flex: 1, minWidth: 0 }}>
          {item ? (
            <MobileDiffReviewFileSummary
              fileNotes={controller.fileNotes}
              item={item}
              staleCommentIds={controller.staleCommentIds}
              onEditNote={controller.openEditComposer}
              onToggleViewed={(target) => void controller.toggleItemViewed(target)}
              hiddenThreadCount={controller.hiddenThreadCount}
            />
          ) : null}
          {/* Each source keeps its own line, so a newer thread failure is never hidden behind older feedback. */}
          {threadCommentActions.error ? (
            <View style={styles.actionError}>
              <Text style={styles.actionErrorText}>{threadCommentActions.error}</Text>
            </View>
          ) : null}
          {controller.actionError ? (
            <View style={styles.actionError}>
              <Text style={styles.actionErrorText}>{controller.actionError}</Text>
            </View>
          ) : null}
          <MobileDiffReviewBody
            commentsByLine={controller.commentsByLine}
            currentItem={item}
            diffState={controller.diffState}
            filteredCount={controller.filteredQueue.length}
            screenState={controller.screenState}
            staleCommentIds={controller.staleCommentIds}
            threadsByLine={controller.threadsByLine}
            threadActions={threadActions}
            selectedRange={selectedRange}
            onPickLines={(range) => controller.openNewNoteSheet({ kind: 'range', ...range })}
            scrollToLine={controller.scrollToLine}
            onScrolledToLine={controller.clearScrollToLine}
            onEditNote={controller.openEditComposer}
            onRetry={controller.retryAction ?? undefined}
            offline={controller.connState !== 'connected'}
            filter={controller.filter}
            onBack={onBack}
          />
          {item ? (
            <MobileDiffReviewFooter
              busyAction={controller.busyAction}
              item={item}
              onMarkViewed={() => void controller.markReviewed()}
              onStageAndOpenNext={() => void controller.stageAndOpenNext()}
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
              rereadSlices={controller.rereadPRSlices}
              hostId={controller.hostId}
              queries={controller.prQueries}
              client={controller.client}
              connState={controller.connState}
              worktreeId={controller.worktreeId}
              hostConnection={hostConnection}
              gitBranch={controller.prSidebarBranch}
              gitStatus={gitStatus}
              headSha={controller.prSidebarHeadSha}
              bottomInset={insets.bottom}
              workspaceLabel={controller.worktreeLabel}
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
            rereadSlices={controller.rereadPRSlices}
            hostId={controller.hostId}
            queries={controller.prQueries}
            client={controller.client}
            connState={controller.connState}
            worktreeId={controller.worktreeId}
            hostConnection={hostConnection}
            gitBranch={controller.prSidebarBranch}
            gitStatus={gitStatus}
            headSha={controller.prSidebarHeadSha}
            workspaceLabel={controller.worktreeLabel}
          />
        </RightDrawer>
      ) : null}
    </SafeAreaView>
  )
}
