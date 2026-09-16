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
import {
  githubProjectCommentUpdate,
  githubProjectCommentWrite,
  githubProjectIssueUpdate,
  githubProjectPullRequestUpdate
} from './mobile-task-project-board-operations'

export function useMobileTasksProjectWorkspaceCommentActions(model: WorkspaceCreateActionsModel) {
  const {
    activeGitHubProjectHost,
    client,
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
      if (!client || projectMutating) {
        return
      }
      const type = projectRowType(row)
      const slug = splitRepositorySlug(row.content.repository)
      if (!type || !slug || !row.content.number) {
        setProjectRowDetailError('This project item cannot be edited from mobile.')
        return
      }
      setProjectMutating(true)
      try {
        // An issue and a pull request are different methods, so each arm sends its own operation
        // rather than one call picking a method string.
        // Params repeated rather than hoisted so each send textually carries its own host, which
        // is what github-project-host-routing-source.test.ts pins.
        const updated =
          type === 'issue'
            ? githubProjectIssueUpdate.interpret(
                await githubProjectIssueUpdate.request(
                  client,
                  {
                    owner: slug.owner,
                    repo: slug.repo,
                    host: activeGitHubProjectHost,
                    number: row.content.number,
                    updates
                  },
                  { timeoutMs: 30_000 }
                )
              )
            : githubProjectPullRequestUpdate.interpret(
                await githubProjectPullRequestUpdate.request(
                  client,
                  {
                    owner: slug.owner,
                    repo: slug.repo,
                    host: activeGitHubProjectHost,
                    number: row.content.number,
                    updates
                  },
                  { timeoutMs: 30_000 }
                )
              )
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
        const result = updated as { ok?: boolean; error?: { message?: string } }
        if (result.ok === false) {
          throw new Error(result.error?.message ?? 'Failed to update GitHub item')
        }
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
    [activeGitHubProjectHost, client, projectMutating]
  )

  const addProjectRowComment = useCallback(
    async (row: GitHubProjectRow): Promise<void> => {
      if (!client || projectMutating) {
        return
      }
      const slug = splitRepositorySlug(row.content.repository)
      const body = projectCommentDraft.trim()
      if (!slug || !row.content.number || !body) {
        return
      }
      setProjectMutating(true)
      try {
        const reply = await githubProjectCommentWrite.request(
          client,
          {
            owner: slug.owner,
            repo: slug.repo,
            host: activeGitHubProjectHost,
            number: row.content.number,
            body
          },
          { timeoutMs: 30_000 }
        )
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
        const result = githubProjectCommentWrite.interpret(reply) as
          | { ok: true; comment?: DetailComment }
          | { ok: false; error?: { message?: string } }
        if (!result.ok) {
          throw new Error(result.error?.message ?? 'Failed to add comment')
        }
        setProjectCommentDraft('')
        if (result.comment) {
          setProjectRowDetail((current) =>
            current?.provider === 'github'
              ? { ...current, comments: [...current.comments, result.comment as DetailComment] }
              : current
          )
        }
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to add comment')
      } finally {
        setProjectMutating(false)
      }
    },
    [activeGitHubProjectHost, client, projectCommentDraft, projectMutating]
  )

  const updateProjectRowComment = useCallback(
    async (row: GitHubProjectRow, comment: DetailComment): Promise<void> => {
      if (!client || projectMutating) {
        return
      }
      const slug = splitRepositorySlug(row.content.repository)
      const commentId = Number(comment.id)
      const body = projectEditingCommentDraft.trim()
      if (!slug || !Number.isInteger(commentId) || commentId <= 0 || !body) {
        setProjectRowDetailError('This project comment cannot be edited from mobile.')
        return
      }
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const reply = await githubProjectCommentUpdate.request(
          client,
          {
            owner: slug.owner,
            repo: slug.repo,
            host: activeGitHubProjectHost,
            commentId,
            body
          },
          { timeoutMs: 30_000 }
        )
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
        const result = githubProjectCommentUpdate.interpret(reply) as {
          ok?: boolean
          error?: string | { message?: string }
        }
        if (result.ok === false) {
          throw new Error(
            typeof result.error === 'string'
              ? result.error
              : (result.error?.message ?? 'Failed to edit comment')
          )
        }
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
    [activeGitHubProjectHost, client, projectEditingCommentDraft, projectMutating]
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
