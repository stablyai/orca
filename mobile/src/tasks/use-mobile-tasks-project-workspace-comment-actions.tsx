import type { WorkspaceCreateActionsModel } from './use-mobile-tasks-workspace-create-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  type DetailComment,
  type GitHubProjectRow,
  type GitHubWorkItem,
  projectRowMutationTarget,
  projectRowSlugTarget,
  projectRowStatusLabel,
  projectRowType,
  splitRepositorySlug
} from './mobile-tasks-model'

export function useMobileTasksProjectWorkspaceCommentActions(model: WorkspaceCreateActionsModel) {
  const {
    activeGitHubProjectHost,
    findProjectRowRepo,
    openWorkspaceCreate,
    projectCommentDraft,
    projectEditingCommentDraft,
    projectMutating,
    setError,
    setGithubProjectTable,
    setProjectCommentDraft,
    setProjectEditingCommentDraft,
    setProjectEditingCommentId,
    setProjectMutating,
    setProjectRepoNotInOrca,
    setProjectRowDetail,
    setProjectRowDetailError,
    setProjectRowItem,
    taskProjectMutationOperations,
    tasksSupported
  } = model
  const createWorkspaceFromProjectRow = useCallback(
    async (row: GitHubProjectRow): Promise<void> => {
      if (!tasksSupported) {
        return
      }
      const kind = projectRowType(row)
      const repo = findProjectRowRepo(row)
      if (!kind || !row.content.number || !row.content.url) {
        setError('Add the project item repository to Orca before creating a workspace.')
        return
      }
      if (!repo) {
        const slug = splitRepositorySlug(row.content.repository)
        setProjectRepoNotInOrca({
          owner: slug?.owner ?? 'Unknown',
          repo: slug?.repo ?? row.content.repository ?? 'repository',
          url: row.content.url ?? null
        })
        return
      }
      const state: GitHubWorkItem['state'] =
        row.content.state === 'MERGED'
          ? 'merged'
          : row.content.state === 'CLOSED'
            ? 'closed'
            : row.content.isDraft
              ? 'draft'
              : 'open'
      const source: GitHubWorkItem = {
        id: row.id,
        type: kind,
        number: row.content.number,
        title: row.content.title,
        state,
        url: row.content.url,
        labels: row.content.labels.map((label) => label.name),
        updatedAt: row.updatedAt,
        author: null,
        repoId: repo.id,
        repoName: repo.displayName
      }
      openWorkspaceCreate({
        key: `github-project:${row.id}`,
        provider: 'github',
        title: row.content.title,
        subtitle: `${repo.displayName} #${row.content.number}`,
        status: projectRowStatusLabel(row),
        updatedAt: row.updatedAt,
        source
      })
    },
    [findProjectRowRepo, openWorkspaceCreate, tasksSupported]
  )
  const mutateProjectRowIssueOrPr = useCallback(
    async (
      row: GitHubProjectRow,
      updates: { title?: string; body?: string; state?: 'open' | 'closed' }
    ): Promise<void> => {
      if (!taskProjectMutationOperations || projectMutating) {
        return
      }
      const target = projectRowMutationTarget(row, activeGitHubProjectHost)
      if (!target) {
        setProjectRowDetailError('This project item cannot be edited from mobile.')
        return
      }
      setProjectMutating(true)
      try {
        await taskProjectMutationOperations.updateItem(target, updates)
        setProjectRowItem((current) => {
          if (!current || current.id !== row.id) {
            return current
          }
          return {
            ...current,
            content: {
              ...current.content,
              ...(updates.title !== undefined ? { title: updates.title } : {}),
              ...(updates.body !== undefined ? { body: updates.body } : {}),
              ...(updates.state !== undefined
                ? { state: updates.state === 'closed' ? 'CLOSED' : 'OPEN' }
                : {})
            }
          }
        })
        setGithubProjectTable((table) =>
          table
            ? {
                ...table,
                rows: table.rows.map((candidate) =>
                  candidate.id === row.id
                    ? {
                        ...candidate,
                        content: {
                          ...candidate.content,
                          ...(updates.title !== undefined ? { title: updates.title } : {}),
                          ...(updates.body !== undefined ? { body: updates.body } : {}),
                          ...(updates.state !== undefined
                            ? { state: updates.state === 'closed' ? 'CLOSED' : 'OPEN' }
                            : {})
                        }
                      }
                    : candidate
                )
              }
            : table
        )
        if (updates.body !== undefined) {
          setProjectRowDetail((current) =>
            current?.provider === 'github' ? { ...current, body: updates.body ?? '' } : current
          )
        }
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to update item')
      } finally {
        setProjectMutating(false)
      }
    },
    [activeGitHubProjectHost, projectMutating, taskProjectMutationOperations]
  )
  const addProjectRowComment = useCallback(
    async (row: GitHubProjectRow): Promise<void> => {
      if (!taskProjectMutationOperations || projectMutating) {
        return
      }
      const target = projectRowMutationTarget(row, activeGitHubProjectHost)
      const body = projectCommentDraft.trim()
      if (!target || !body) {
        return
      }
      setProjectMutating(true)
      try {
        const comment = await taskProjectMutationOperations.addComment(target, body)
        setProjectCommentDraft('')
        if (comment) {
          setProjectRowDetail((current) =>
            current?.provider === 'github'
              ? { ...current, comments: [...current.comments, comment as DetailComment] }
              : current
          )
        }
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to add comment')
      } finally {
        setProjectMutating(false)
      }
    },
    [activeGitHubProjectHost, projectCommentDraft, projectMutating, taskProjectMutationOperations]
  )
  const updateProjectRowComment = useCallback(
    async (row: GitHubProjectRow, comment: DetailComment): Promise<void> => {
      if (!taskProjectMutationOperations || projectMutating) {
        return
      }
      // Why: `updateIssueCommentBySlug` addresses by repository and comment id only.
      const target = projectRowSlugTarget(row, activeGitHubProjectHost)
      const commentId = Number(comment.id)
      const body = projectEditingCommentDraft.trim()
      if (!target || !Number.isInteger(commentId) || commentId <= 0 || !body) {
        setProjectRowDetailError('This project comment cannot be edited from mobile.')
        return
      }
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        await taskProjectMutationOperations.updateComment(target, commentId, body)
        setProjectRowDetail((current) =>
          current?.provider === 'github'
            ? {
                ...current,
                comments: current.comments.map((candidate) =>
                  Number(candidate.id) === commentId ? { ...candidate, body } : candidate
                )
              }
            : current
        )
        setProjectEditingCommentId(null)
        setProjectEditingCommentDraft('')
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to edit comment')
      } finally {
        setProjectMutating(false)
      }
    },
    [
      activeGitHubProjectHost,
      projectEditingCommentDraft,
      projectMutating,
      taskProjectMutationOperations
    ]
  )
  return Object.assign(model, {
    addProjectRowComment,
    createWorkspaceFromProjectRow,
    mutateProjectRowIssueOrPr,
    updateProjectRowComment
  })
}

export type ProjectWorkspaceCommentActionsModel = ReturnType<
  typeof useMobileTasksProjectWorkspaceCommentActions
>
