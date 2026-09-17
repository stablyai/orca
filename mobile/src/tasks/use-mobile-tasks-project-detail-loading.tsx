import type { ItemDetailLoadingModel } from './use-mobile-tasks-item-detail-loading'
import { useEffect } from './mobile-tasks-dependencies'
import {
  type DetailComment,
  type GitHubAssignableUser,
  type GitHubDetailCheck,
  type GitHubDetailFile,
  type GitHubPRReviewSummary,
  editableProjectFields,
  projectFieldDraftValue,
  projectRowType,
  splitRepositorySlug
} from './mobile-tasks-legacy-foundation'
import { githubProjectRowDetailRead } from './mobile-task-project-board-operations'

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
        // Why the casts and not a narrower schema: comments, reviews, checks and files are host
        // records this pane renders whole, and the recorded detail carries every one of them empty
        // — so a member requirement here has nothing behind it and would drop a row main showed.
        // `reviewDecision` is forwarded with no coalesce: explicit null and absent are different
        // answers to "has this been reviewed", and collapsing either is a product change.
        setProjectRowDetail({
          provider: 'github',
          body: result.details.body ?? '',
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above; the thread renderer owns the comment shape.
          comments: (result.details.comments ?? []) as DetailComment[],
          labels: result.details.item?.labels ?? projectRowItem.content.labels.map((l) => l.name),
          assignees: result.details.assignees ?? [],
          reviewDecision: result.details.item?.reviewDecision,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above; the reviewer strip owns these two shapes.
          reviewRequests: (result.details.item?.reviewRequests ?? []) as GitHubAssignableUser[],
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above.
          latestReviews: (result.details.item?.latestReviews ?? []) as GitHubPRReviewSummary[],
          headSha: result.details.headSha,
          baseSha: result.details.baseSha,
          pullRequestId: result.details.pullRequestId,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above; the checks panel owns this shape.
          checks: (result.details.checks ?? []) as GitHubDetailCheck[],
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above; the files list owns this shape.
          files: (result.details.files ?? []) as GitHubDetailFile[]
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
