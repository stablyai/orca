import type { WorkspaceCreateActionsModel } from './use-mobile-tasks-workspace-create-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  type DetailComment,
  type GitHubProjectRow,
  type GitHubWorkItem,
  projectRowStatusLabel,
  projectRowType,
  splitRepositorySlug
} from './mobile-tasks-legacy-foundation'
import { projectRowMutationTarget, projectRowSlugTarget } from './mobile-tasks-mutation-targets'

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
    taskOperations,
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
      if (!taskOperations || projectMutating) {
        return
      }
      const target = projectRowMutationTarget(row, activeGitHubProjectHost)
      if (!target) {
        setProjectRowDetailError('This project item cannot be edited from mobile.')
        return
      }
      setProjectMutating(true)
      try {
        await taskOperations.projectMutation.updateItem(target, updates)
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
    [activeGitHubProjectHost, projectMutating, taskOperations]
  )

  const addProjectRowComment = useCallback(
    async (row: GitHubProjectRow): Promise<void> => {
      if (!taskOperations || projectMutating) {
        return
      }
      // Adding a comment requires a repository slug, item number, and non-empty body.
      const target = projectRowSlugTarget(row, activeGitHubProjectHost)
      const body = projectCommentDraft.trim()
      if (!target || !row.content.number || !body) {
        return
      }
      setProjectMutating(true)
      try {
        const comment = await taskOperations.projectMutation.addComment(target, body)
        setProjectCommentDraft('')
        if (comment) {
          setProjectRowDetail((current) =>
            current?.provider === 'github'
              ? { ...current, comments: [...current.comments, comment] }
              : current
          )
        }
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to add comment')
      } finally {
        setProjectMutating(false)
      }
    },
    [activeGitHubProjectHost, projectCommentDraft, projectMutating, taskOperations]
  )

  const updateProjectRowComment = useCallback(
    async (row: GitHubProjectRow, comment: DetailComment): Promise<void> => {
      if (!taskOperations || projectMutating) {
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
        await taskOperations.projectMutation.updateComment(target, commentId, body)
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
    [activeGitHubProjectHost, projectEditingCommentDraft, projectMutating, taskOperations]
  )
  return Object.assign(model, {
    createWorkspaceFromProjectRow,
    mutateProjectRowIssueOrPr,
    addProjectRowComment,
    updateProjectRowComment
  })
}

export type ProjectWorkspaceCommentActionsModel = ReturnType<
  typeof useMobileTasksProjectWorkspaceCommentActions
>
