import type { PageChromeModel } from './use-mobile-tasks-page-chrome'
import {
  SafeAreaView,
  View,
  ActionSheetModal,
  BottomDrawerModalHost,
  ConfirmModal,
  Combine,
  GitMerge,
  ListOrdered
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import {
  getHostedReviewMergeMethodLabel,
  getHostedMergeConfirmMessage,
  getProjectGitHubMergeConfirmMessage,
  getHostedStateConfirmTitle,
  getHostedStateConfirmMessage,
  getHostedStateConfirmLabel
} from './mobile-tasks-legacy-foundation'
import { renderMobileTasksStatusBar } from './mobile-tasks-screen-chrome'
import { renderMobileTasksFilterSheet } from './mobile-tasks-filter-sheet'
import {
  mobileTasksItemMenuActions,
  mobileTasksProjectMenuActions
} from './mobile-tasks-item-actions'
import type { HostedReviewMergeMethod } from './mobile-tasks-legacy-foundation'
import { renderMobileTasksListSurface } from './mobile-tasks-list-surface'
import {
  renderMobileTasksProviderPicker,
  renderMobileTasksRepoPicker,
  renderMobileTasksGitHubIssueSourcePicker,
  renderMobileTasksGitHubViewPicker,
  renderMobileTasksGitHubPresetPicker,
  renderMobileTasksPagePicker
} from './mobile-tasks-provider-pickers'
import {
  renderMobileTasksGitHubProjectPicker,
  renderMobileTasksGitHubProjectViewPicker,
  renderMobileTasksGitHubProjectSortPicker
} from './mobile-tasks-github-project-pickers'
import {
  renderMobileTasksGitHubProjectFieldsPicker,
  renderMobileTasksGitLabViewPicker,
  renderMobileTasksGitLabFilterPicker,
  renderMobileTasksJiraFilterPicker,
  renderMobileTasksJiraSitePicker,
  renderMobileTasksLinearFilterPicker,
  renderMobileTasksLinearWorkspacePicker,
  renderMobileTasksLinearTeamPicker,
  renderMobileTasksLinearStatusPicker
} from './mobile-tasks-filter-pickers'
import {
  renderMobileTasksLinearViewPicker,
  renderMobileTasksLinearGroupPicker,
  renderMobileTasksLinearOrderPicker,
  renderMobileTasksLinearDisplayPicker,
  renderMobileTasksSortPicker
} from './mobile-tasks-list-display-pickers'
import {
  renderMobileTasksCreateDrawer,
  renderMobileTasksCreateTargetPicker,
  renderMobileTasksLinearConnectDrawer,
  renderMobileTasksWorkspaceCreateTargetPicker
} from './mobile-tasks-create-drawers'
import {
  renderMobileTasksWorkspaceCreateDrawer,
  renderMobileTasksWorkspaceCreateRepoPicker,
  renderMobileTasksWorkspaceAgentPicker
} from './mobile-tasks-workspace-create-drawer'
import {
  renderMobileTasksWorkspaceBaseBranchPicker,
  renderMobileTasksWorkspaceSparsePicker
} from './mobile-tasks-workspace-option-pickers'
import {
  renderMobileTasksWorkspaceSparseDrawer,
  renderMobileTasksSetupTrustDrawer,
  renderMobileTasksOrcaYamlTrustDrawer
} from './mobile-tasks-workspace-trust-drawers'
import {
  renderMobileTasksProjectMissingRepoDrawer,
  renderMobileTasksProjectDetailDrawer
} from './mobile-tasks-project-detail-drawer'
import { renderMobileTasksItemDetailDrawer } from './mobile-tasks-item-detail-drawer'

// Each method says what it does to history, so the choice doesn't need a desktop to explain it.
const MERGE_METHOD_ICON = {
  squash: Combine,
  merge: GitMerge,
  rebase: ListOrdered
} as const
const MERGE_METHOD_HINT: Record<HostedReviewMergeMethod, string> = {
  squash: 'Combines every commit into one on the base branch.',
  merge: 'Keeps every commit and adds a merge commit.',
  rebase: 'Replays each commit onto the base branch.'
}

export function MobileTasksLegacySurface({ model }: { model: PageChromeModel }) {
  const {
    actionItem,
    detailMenu,
    mergeHostedReview,
    mergeMethodProjectRow,
    mergeMethodTaskItem,
    mergeProjectGitHubPullRequest,
    mutateProjectRowIssueOrPr,
    pendingHostedMerge,
    pendingHostedStateChange,
    pendingProjectGitHubMerge,
    projectRowItem,
    setDetailMenu,
    setMergeMethodProjectRow,
    setMergeMethodTaskItem,
    setPendingHostedMerge,
    setPendingHostedStateChange,
    setPendingProjectGitHubMerge,
    setTaskCopyFeedbackRootRef,
    taskUiReady,
    toggleGitHubStatus,
    toggleGitLabStatus
  } = model
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View ref={setTaskCopyFeedbackRootRef} style={styles.page}>
        {renderMobileTasksStatusBar(model)}
        {renderMobileTasksListSurface(model)}
      </View>

      {/* Why: Tasks stacks sheets (an issue detail under Create Workspace or a confirm), and iOS
          refuses a native modal over a presented sibling, so they share one Modal, ordered by zIndex. */}
      <BottomDrawerModalHost>
        {renderMobileTasksProviderPicker(model)}

        {renderMobileTasksRepoPicker(model)}

        {renderMobileTasksGitHubIssueSourcePicker(model)}

        {renderMobileTasksGitHubViewPicker(model)}

        {renderMobileTasksGitHubPresetPicker(model)}

        {renderMobileTasksPagePicker(model)}

        {renderMobileTasksGitHubProjectPicker(model)}

        {renderMobileTasksGitHubProjectViewPicker(model)}

        {renderMobileTasksGitHubProjectSortPicker(model)}

        {renderMobileTasksGitHubProjectFieldsPicker(model)}

        {renderMobileTasksGitLabViewPicker(model)}

        {renderMobileTasksGitLabFilterPicker(model)}

        {renderMobileTasksLinearFilterPicker(model)}
        {renderMobileTasksJiraFilterPicker(model)}
        {renderMobileTasksJiraSitePicker(model)}

        {renderMobileTasksLinearWorkspacePicker(model)}

        {renderMobileTasksLinearTeamPicker(model)}

        {renderMobileTasksLinearStatusPicker(model)}

        {renderMobileTasksLinearViewPicker(model)}

        {renderMobileTasksLinearGroupPicker(model)}

        {renderMobileTasksLinearOrderPicker(model)}

        {renderMobileTasksLinearDisplayPicker(model)}

        {renderMobileTasksSortPicker(model)}

        {renderMobileTasksCreateDrawer(model)}

        {renderMobileTasksCreateTargetPicker(model)}

        {renderMobileTasksLinearConnectDrawer(model)}

        {renderMobileTasksWorkspaceCreateTargetPicker(model)}

        {renderMobileTasksWorkspaceCreateDrawer(model)}

        {renderMobileTasksWorkspaceCreateRepoPicker(model)}

        {renderMobileTasksWorkspaceAgentPicker(model)}

        {renderMobileTasksWorkspaceBaseBranchPicker(model)}

        {renderMobileTasksWorkspaceSparsePicker(model)}

        {renderMobileTasksWorkspaceSparseDrawer(model)}

        {renderMobileTasksSetupTrustDrawer(model)}

        {renderMobileTasksOrcaYamlTrustDrawer(model)}

        {renderMobileTasksProjectMissingRepoDrawer(model)}

        {renderMobileTasksProjectDetailDrawer(model)}

        {renderMobileTasksItemDetailDrawer(model)}

        {renderMobileTasksFilterSheet(model)}

        <ActionSheetModal
          visible={taskUiReady && detailMenu === 'item' && actionItem != null}
          title={actionItem?.title}
          actions={mobileTasksItemMenuActions(model)}
          onClose={() => setDetailMenu(null)}
        />
        <ActionSheetModal
          visible={taskUiReady && detailMenu === 'project' && projectRowItem != null}
          title={projectRowItem?.content.title}
          actions={mobileTasksProjectMenuActions(model)}
          onClose={() => setDetailMenu(null)}
        />

        <ActionSheetModal
          visible={taskUiReady && mergeMethodProjectRow != null}
          title="Merge method"
          message="Choose how this pull request should be merged."
          actions={
            mergeMethodProjectRow
              ? (['squash', 'merge', 'rebase'] as const).map((method) => ({
                  label: getHostedReviewMergeMethodLabel(method),
                  icon: MERGE_METHOD_ICON[method],
                  hint: MERGE_METHOD_HINT[method],
                  onPress: () => {
                    setPendingProjectGitHubMerge({
                      row: mergeMethodProjectRow,
                      method
                    })
                  }
                }))
              : []
          }
          onClose={() => setMergeMethodProjectRow(null)}
        />
        <ActionSheetModal
          visible={taskUiReady && mergeMethodTaskItem != null}
          title="Merge method"
          message={
            mergeMethodTaskItem?.provider === 'gitlab'
              ? 'Choose how this merge request should be merged.'
              : 'Choose how this pull request should be merged.'
          }
          actions={
            mergeMethodTaskItem
              ? (mergeMethodTaskItem.provider === 'gitlab'
                  ? (['merge', 'squash', 'rebase'] as const)
                  : (['squash', 'merge', 'rebase'] as const)
                ).map((method) => ({
                  label:
                    mergeMethodTaskItem.provider === 'gitlab' && method === 'merge'
                      ? 'Merge'
                      : getHostedReviewMergeMethodLabel(method),
                  icon: MERGE_METHOD_ICON[method],
                  hint: MERGE_METHOD_HINT[method],
                  onPress: () => {
                    const item = mergeMethodTaskItem
                    setPendingHostedMerge({ item, method })
                  }
                }))
              : []
          }
          onClose={() => setMergeMethodTaskItem(null)}
        />
        <ConfirmModal
          visible={taskUiReady && pendingHostedMerge != null}
          title={
            pendingHostedMerge?.item.provider === 'gitlab'
              ? 'Merge merge request'
              : 'Merge pull request'
          }
          message={
            pendingHostedMerge ? getHostedMergeConfirmMessage(pendingHostedMerge) : undefined
          }
          confirmLabel={
            pendingHostedMerge
              ? getHostedReviewMergeMethodLabel(pendingHostedMerge.method)
              : 'Merge'
          }
          onConfirm={() => {
            if (!taskUiReady || !pendingHostedMerge) {
              return
            }
            void mergeHostedReview(pendingHostedMerge.item, pendingHostedMerge.method)
          }}
          onCancel={() => setPendingHostedMerge(null)}
        />
        <ConfirmModal
          visible={taskUiReady && pendingProjectGitHubMerge != null}
          title="Merge pull request"
          message={
            pendingProjectGitHubMerge
              ? getProjectGitHubMergeConfirmMessage(pendingProjectGitHubMerge)
              : undefined
          }
          confirmLabel={
            pendingProjectGitHubMerge
              ? getHostedReviewMergeMethodLabel(pendingProjectGitHubMerge.method)
              : 'Merge'
          }
          onConfirm={() => {
            if (!taskUiReady || !pendingProjectGitHubMerge) {
              return
            }
            void mergeProjectGitHubPullRequest(
              pendingProjectGitHubMerge.row,
              pendingProjectGitHubMerge.method
            )
          }}
          onCancel={() => setPendingProjectGitHubMerge(null)}
        />
        <ConfirmModal
          visible={taskUiReady && pendingHostedStateChange != null}
          title={
            pendingHostedStateChange
              ? getHostedStateConfirmTitle(pendingHostedStateChange)
              : 'Update item'
          }
          message={
            pendingHostedStateChange
              ? getHostedStateConfirmMessage(pendingHostedStateChange)
              : undefined
          }
          confirmLabel={
            pendingHostedStateChange
              ? getHostedStateConfirmLabel(pendingHostedStateChange)
              : 'Confirm'
          }
          destructive={pendingHostedStateChange?.nextState === 'closed'}
          onConfirm={() => {
            if (!taskUiReady || !pendingHostedStateChange) {
              return
            }
            if (pendingHostedStateChange.source === 'task') {
              if (pendingHostedStateChange.item.provider === 'gitlab') {
                void toggleGitLabStatus(pendingHostedStateChange.item)
                return
              }
              void toggleGitHubStatus(pendingHostedStateChange.item)
              return
            }
            void mutateProjectRowIssueOrPr(pendingHostedStateChange.row, {
              state: pendingHostedStateChange.nextState
            })
          }}
          onCancel={() => setPendingHostedStateChange(null)}
        />
      </BottomDrawerModalHost>
    </SafeAreaView>
  )
}
