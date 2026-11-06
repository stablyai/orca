import type { ItemDetailLoadingModel } from './use-mobile-tasks-item-detail-loading'
import { useEffect, useLayoutEffect } from './mobile-tasks-dependencies'
import {
  editableProjectFields,
  projectFieldDraftValue,
  projectRowType,
  splitRepositorySlug
} from './mobile-tasks-legacy-foundation'
import { githubProjectRowDetailRead } from './mobile-task-project-board-operations'

export function useMobileTasksProjectDetailLoading<
  Model extends Pick<
    ItemDetailLoadingModel,
    | 'activeGitHubProjectHost'
    | 'client'
    | 'githubProjectTable'
    | 'projectRowDetailRefreshSeq'
    | 'projectRowItem'
    | 'setExpandedPrFilePath'
    | 'setPrFileCommentDrafts'
    | 'resetPrFiles'
    | 'setProjectBodyDraft'
    | 'setProjectCommentDraft'
    | 'setProjectEditingCommentDraft'
    | 'setProjectEditingCommentId'
    | 'setProjectFieldDrafts'
    | 'setProjectReviewersDraft'
    | 'setProjectRowDetail'
    | 'setProjectRowDetailError'
    | 'setProjectRowDetailLoading'
    | 'setProjectTitleDraft'
    | 'tasksSupported'
  >
>(model: Model) {
  const {
    activeGitHubProjectHost,
    client,
    githubProjectTable,
    projectRowDetailRefreshSeq,
    projectRowItem,
    setExpandedPrFilePath,
    setPrFileCommentDrafts,
    resetPrFiles,
    setProjectBodyDraft,
    setProjectCommentDraft,
    setProjectEditingCommentDraft,
    setProjectEditingCommentId,
    setProjectFieldDrafts,
    setProjectReviewersDraft,
    setProjectRowDetail,
    setProjectRowDetailError,
    setProjectRowDetailLoading,
    setProjectTitleDraft,
    tasksSupported
  } = model
  useLayoutEffect(() => {
    resetPrFiles()
  }, [projectRowItem, client, projectRowDetailRefreshSeq, resetPrFiles])
  useEffect(() => {
    if (!projectRowItem) {
      setProjectRowDetail(null)
      setProjectRowDetailLoading(false)
      setProjectRowDetailError('')
      setProjectTitleDraft('')
      setProjectBodyDraft('')
      setProjectCommentDraft('')
      setProjectEditingCommentId(null)
      setProjectEditingCommentDraft('')
      setProjectReviewersDraft('')
      setExpandedPrFilePath(null)
      setPrFileCommentDrafts({})
      setProjectFieldDrafts({})
      return
    }

    const type = projectRowType(projectRowItem)
    const slug = splitRepositorySlug(projectRowItem.content.repository)
    setProjectTitleDraft(projectRowItem.content.title)
    setProjectBodyDraft(projectRowItem.content.body ?? '')
    setProjectCommentDraft('')
    setProjectEditingCommentId(null)
    setProjectEditingCommentDraft('')
    setProjectReviewersDraft('')
    setExpandedPrFilePath(null)
    setPrFileCommentDrafts({})
    setProjectFieldDrafts(
      Object.fromEntries(
        editableProjectFields(githubProjectTable).map((field) => [
          field.id,
          projectFieldDraftValue(projectRowItem, field)
        ])
      )
    )
    setProjectRowDetail(null)
    setProjectRowDetailError('')

    if (!tasksSupported || !client || !type || !slug || !projectRowItem.content.number) {
      setProjectRowDetailLoading(false)
      return
    }

    let stale = false
    setProjectRowDetailLoading(true)

    void githubProjectRowDetailRead
      .request(
        client,
        {
          owner: slug.owner,
          repo: slug.repo,
          host: activeGitHubProjectHost,
          number: projectRowItem.content.number,
          type
        },
        { timeoutMs: 30_000 }
      )
      .then((response) => {
        if (stale) {
          return
        }
        const result = githubProjectRowDetailRead.interpret(response)
        if (!result.ok) {
          throw new Error(result.error.message)
        }
        // Forward reviewDecision unchanged: null and absence represent distinct review states.
        setProjectRowDetail({
          provider: 'github',
          body: result.details.body ?? '',
          comments: result.details.comments ?? [],
          labels: result.details.item?.labels ?? projectRowItem.content.labels.map((l) => l.name),
          assignees: result.details.assignees ?? [],
          reviewDecision: result.details.item?.reviewDecision,
          reviewRequests: result.details.item?.reviewRequests ?? [],
          latestReviews: result.details.item?.latestReviews ?? [],
          headSha: result.details.headSha,
          baseSha: result.details.baseSha,
          pullRequestId: result.details.pullRequestId,
          checks: result.details.checks ?? [],
          files: result.details.files ?? []
        })
      })
      .catch((err) => {
        if (!stale) {
          setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to load details')
        }
      })
      .finally(() => {
        if (!stale) {
          setProjectRowDetailLoading(false)
        }
      })

    return () => {
      stale = true
    }
  }, [
    activeGitHubProjectHost,
    client,
    githubProjectTable,
    projectRowDetailRefreshSeq,
    projectRowItem,
    tasksSupported
  ])
  return model
}

export type ProjectDetailLoadingModel = ItemDetailLoadingModel &
  ReturnType<typeof useMobileTasksProjectDetailLoading>
