import type { ItemDetailLoadingModel } from './use-mobile-tasks-item-detail-loading'
import { useEffect } from './mobile-tasks-dependencies'
import {
  editableProjectFields,
  projectFieldDraftValue,
  projectRowType,
  splitRepositorySlug
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksProjectDetailLoading(model: ItemDetailLoadingModel) {
  const {
    activeGitHubProjectHost,
    githubProjectTable,
    projectRowDetailRefreshSeq,
    projectRowItem,
    setExpandedPrFilePath,
    setPrFileCommentDrafts,
    setPrFileContents,
    setPrFileLoadingPath,
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
    taskOperations,
    tasksSupported
  } = model
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
      setPrFileContents({})
      setPrFileLoadingPath(null)
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
    setPrFileContents({})
    setPrFileLoadingPath(null)
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

    if (!tasksSupported || !taskOperations || !type || !slug || !projectRowItem.content.number) {
      setProjectRowDetailLoading(false)
      return
    }

    let stale = false
    setProjectRowDetailLoading(true)

    void taskOperations.projectRead
      .loadItemDetail({
        owner: slug.owner,
        repo: slug.repo,
        host: activeGitHubProjectHost,
        number: projectRowItem.content.number,
        type
      })
      .then((details) => {
        if (stale) {
          return
        }
        setProjectRowDetail({
          provider: 'github',
          body: details.body,
          comments: details.comments,
          // Why: the row already knows its labels when the host omits them.
          labels: details.labels ?? projectRowItem.content.labels.map((label) => label.name),
          assignees: details.assignees,
          reviewDecision: details.reviewDecision,
          reviewRequests: details.reviewRequests ?? [],
          latestReviews: details.latestReviews ?? [],
          headSha: details.headSha,
          baseSha: details.baseSha,
          pullRequestId: details.pullRequestId,
          checks: details.checks,
          files: details.files
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
    githubProjectTable,
    projectRowDetailRefreshSeq,
    projectRowItem,
    taskOperations,
    tasksSupported
  ])
  return model
}

export type ProjectDetailLoadingModel = ReturnType<typeof useMobileTasksProjectDetailLoading>
