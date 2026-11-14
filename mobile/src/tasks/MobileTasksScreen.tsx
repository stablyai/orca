import { useMobileTasksRouteAndItemState } from './screen-state/use-mobile-tasks-route-and-item-state'
import { useMobileTasksWorkspaceAndProjectState } from './project-board/use-mobile-tasks-workspace-and-project-state'
import { useMobileTasksProjectProjection } from './project-board/use-mobile-tasks-project-projection'
import { useMobileTasksProjectRepositoryResolution } from './project-board/use-mobile-tasks-project-repository-resolution'
import { useMobileTasksClientSettingsActions } from './screen-state/use-mobile-tasks-client-settings-actions'
import { useMobileTasksRuntimeHydration } from './screen-state/use-mobile-tasks-runtime-hydration'
import { useMobileTasksProviderLoadActions } from './task-list/use-mobile-tasks-provider-load-actions'
import { useMobileTasksTaskListLoading } from './task-list/use-mobile-tasks-task-list-loading'
import { useMobileTasksTaskPaginationActions } from './task-list/use-mobile-tasks-task-pagination-actions'
import { useMobileTasksProjectLoadingActions } from './project-board/use-mobile-tasks-project-loading-actions'
import { useMobileTasksListAndDetailEffects } from './task-list/use-mobile-tasks-list-and-detail-effects'
import { useMobileTasksItemDetailMetadataEffects } from './item-detail/use-mobile-tasks-item-detail-metadata-effects'
import { useMobileTasksItemDetailLoading } from './item-detail/use-mobile-tasks-item-detail-loading'
import { useMobileTasksProjectDetailLoading } from './project-board/use-mobile-tasks-project-detail-loading'
import { useMobileTasksProjectMetadataLoading } from './project-board/use-mobile-tasks-project-metadata-loading'
import { useMobileTasksWorkspaceCreateProjection } from './project-board/use-mobile-tasks-workspace-create-projection'
import { useMobileTasksWorkspaceSourceEffects } from './workspace-creation/use-mobile-tasks-workspace-source-effects'
import { useMobileTasksWorkspaceSparseActions } from './workspace-creation/use-mobile-tasks-workspace-sparse-actions'
import { useMobileTasksWorkspaceSshState } from './workspace-creation/use-mobile-tasks-workspace-ssh-state'
import { useMobileTasksWorkspaceCreateActions } from './workspace-creation/use-mobile-tasks-workspace-create-actions'
import { useMobileTasksProjectWorkspaceCommentActions } from './project-board/use-mobile-tasks-project-workspace-comment-actions'
import { useMobileTasksProjectThreadReplyActions } from './project-board/use-mobile-tasks-project-thread-reply-actions'
import { useMobileTasksProjectMetadataActions } from './project-board/use-mobile-tasks-project-metadata-actions'
import { useMobileTasksProjectReviewCheckActions } from './project-board/use-mobile-tasks-project-review-check-actions'
import { useMobileTasksProjectFileMergeActions } from './project-board/use-mobile-tasks-project-file-merge-actions'
import { useMobileTasksGitlabGithubStatusActions } from './item-detail/use-mobile-tasks-gitlab-github-status-actions'
import { useMobileTasksHostedMetadataActions } from './item-detail/use-mobile-tasks-hosted-metadata-actions'
import { useMobileTasksHostedCommentReviewActions } from './item-detail/use-mobile-tasks-hosted-comment-review-actions'
import { useMobileTasksGithubCheckFileActions } from './item-detail/use-mobile-tasks-github-check-file-actions'
import { useMobileTasksGithubReplyMergeActions } from './item-detail/use-mobile-tasks-github-reply-merge-actions'
import { useMobileTasksLinearItemActions } from './providers/linear/use-mobile-tasks-linear-item-actions'
import { useMobileTasksTaskCreateActions } from './task-list/use-mobile-tasks-task-create-actions'
import { useMobileTasksDetailCommentRenderers } from './item-detail/use-mobile-tasks-detail-comment-renderers'
import { useMobileTasksPickerProjection } from './project-board/use-mobile-tasks-picker-projection'
import { useMobileTasksProviderViewProjection } from './project-board/use-mobile-tasks-provider-view-projection'
import { useMobileTasksConnectionPresentation } from './screen-state/use-mobile-tasks-connection-presentation'
import { MobileTasksLegacySurface } from './MobileTasksLegacySurface'

export function MobileTasksScreen() {
  const stage1 = useMobileTasksRouteAndItemState()
  const stage2 = useMobileTasksWorkspaceAndProjectState(stage1)
  const stage3 = useMobileTasksProjectProjection(stage2)
  const stage4 = useMobileTasksProjectRepositoryResolution(stage3)
  const stage5 = useMobileTasksClientSettingsActions(stage4)
  const stage6 = useMobileTasksRuntimeHydration(stage5)
  const stage7 = useMobileTasksProviderLoadActions(stage6)
  const stage8 = useMobileTasksTaskListLoading(stage7)
  const stage9 = useMobileTasksTaskPaginationActions(stage8)
  const stage10 = useMobileTasksProjectLoadingActions(stage9)
  const stage11 = useMobileTasksListAndDetailEffects(stage10)
  const stage12 = useMobileTasksItemDetailMetadataEffects(stage11)
  const stage13 = useMobileTasksItemDetailLoading(stage12)
  const stage14 = useMobileTasksProjectDetailLoading(stage13)
  const stage15 = useMobileTasksProjectMetadataLoading(stage14)
  const stage16 = useMobileTasksWorkspaceCreateProjection(stage15)
  const stage17 = useMobileTasksWorkspaceSourceEffects(stage16)
  const stage18 = useMobileTasksWorkspaceSparseActions(stage17)
  const stage19 = useMobileTasksWorkspaceSshState(stage18)
  const stage20 = useMobileTasksWorkspaceCreateActions(stage19)
  const stage21 = useMobileTasksProjectWorkspaceCommentActions(stage20)
  const stage22 = useMobileTasksProjectThreadReplyActions(stage21)
  const stage23 = useMobileTasksProjectMetadataActions(stage22)
  const stage24 = useMobileTasksProjectReviewCheckActions(stage23)
  const stage25 = useMobileTasksProjectFileMergeActions(stage24)
  const stage26 = useMobileTasksGitlabGithubStatusActions(stage25)
  const stage27 = useMobileTasksHostedMetadataActions(stage26)
  const stage28 = useMobileTasksHostedCommentReviewActions(stage27)
  const stage29 = useMobileTasksGithubCheckFileActions(stage28)
  const stage30 = useMobileTasksGithubReplyMergeActions(stage29)
  const stage31 = useMobileTasksLinearItemActions(stage30)
  const stage32 = useMobileTasksTaskCreateActions(stage31)
  const stage33 = useMobileTasksDetailCommentRenderers(stage32)
  const stage34 = useMobileTasksPickerProjection(stage33)
  const stage35 = useMobileTasksProviderViewProjection(stage34)
  const stage36 = useMobileTasksConnectionPresentation(stage35)
  return MobileTasksLegacySurface({ model: stage36 })
}
