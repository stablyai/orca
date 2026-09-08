import type { ItemDetailLoadingModel } from './use-mobile-tasks-item-detail-loading'
import { useCallback, useEffect } from './mobile-tasks-dependencies'
import {
  editableProjectFields,
  projectFieldDraftValue,
  projectRowType,
  splitRepositorySlug
} from './mobile-tasks-model'

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
    taskProjectReadOperations,
    tasksSupported
  } = model
  const clearPrFileContents = useCallback(() => {
    setPrFileContents({})
    setPrFileLoadingPath(null)
  }, [setPrFileContents, setPrFileLoadingPath])
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
      clearPrFileContents()
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
    clearPrFileContents()
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

    if (
      !tasksSupported ||
      !taskProjectReadOperations ||
      !type ||
      !slug ||
      !projectRowItem.content.number
    ) {
      setProjectRowDetailLoading(false)
      return
    }

    let stale = false
    setProjectRowDetailLoading(true)

    void taskProjectReadOperations
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
          ...details,
          labels: details.labels ?? projectRowItem.content.labels.map((label) => label.name),
          reviewRequests: details.reviewRequests ?? [],
          latestReviews: details.latestReviews ?? []
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
    clearPrFileContents,
    githubProjectTable,
    projectRowDetailRefreshSeq,
    projectRowItem,
    taskProjectReadOperations,
    tasksSupported
  ])
  return Object.assign(model, {})
}

export type ProjectDetailLoadingModel = ReturnType<typeof useMobileTasksProjectDetailLoading>
