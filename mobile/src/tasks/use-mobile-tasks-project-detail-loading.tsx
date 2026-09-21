import type { ItemDetailLoadingModel } from './use-mobile-tasks-item-detail-loading'
import { useEffect } from './mobile-tasks-dependencies'
import {
  type DetailComment,
  type GitHubAssignableUser,
  type GitHubDetailCheck,
  type GitHubDetailFile,
  type GitHubPRReviewSummary,
  editableProjectFields,
  isSuccess,
  projectFieldDraftValue,
  projectRowType,
  splitRepositorySlug
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksProjectDetailLoading(model: ItemDetailLoadingModel) {
  const {
    activeGitHubProjectHost,
    client,
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

    if (!tasksSupported || !client || !type || !slug || !projectRowItem.content.number) {
      setProjectRowDetailLoading(false)
      return
    }

    let stale = false
    setProjectRowDetailLoading(true)

    void client
      .sendRequest(
        'github.project.workItemDetailsBySlug',
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
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as
          | {
              ok: true
              details: {
                body?: string
                comments?: DetailComment[]
                item?: {
                  labels?: string[]
                  reviewDecision?: string | null
                  reviewRequests?: GitHubAssignableUser[]
                  latestReviews?: GitHubPRReviewSummary[]
                }
                assignees?: string[]
                headSha?: string
                baseSha?: string
                pullRequestId?: string
                checks?: GitHubDetailCheck[]
                files?: Array<{
                  path: string
                  oldPath?: string
                  status?: GitHubDetailFile['status']
                  additions?: number
                  deletions?: number
                  isBinary?: boolean
                  viewerViewedState?: 'DISMISSED' | 'VIEWED' | 'UNVIEWED'
                }>
              }
            }
          | { ok: false; error: { message: string } }
        if (!result.ok) {
          throw new Error(result.error.message)
        }
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

export type ProjectDetailLoadingModel = ReturnType<typeof useMobileTasksProjectDetailLoading>
