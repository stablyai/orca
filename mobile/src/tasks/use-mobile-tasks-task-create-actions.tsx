import type { LinearItemActionsModel } from './use-mobile-tasks-linear-item-actions'
import { colors, useCallback } from './mobile-tasks-dependencies'
import {
  type RepoSummary,
  type TaskItem,
  createGitHubTask,
  createGitLabTask,
  createLinearTask
} from './mobile-tasks-legacy-foundation'
import {
  githubIssueCreate,
  gitlabIssueCreate,
  linearIssueCreate
} from './mobile-task-item-state-operations'
import { taskRepoPreferenceWrite } from './mobile-task-list-operations'

export function useMobileTasksTaskCreateActions(model: LinearItemActionsModel) {
  const {
    client,
    createBody,
    createRepoId,
    createTeamId,
    createTitle,
    creatingTask,
    hostedRepos,
    linearTeams,
    loadTasks,
    provider,
    repoListReload,
    setActionItem,
    setCreateBody,
    setCreateTitle,
    setCreatingTask,
    setError,
    setShowCreateTask,
    taskStateHydrated,
    taskUiReady,
    tasksSupported
  } = model
  const createTask = useCallback(async (): Promise<void> => {
    if (!client || !tasksSupported || !taskStateHydrated || creatingTask) {
      return
    }
    const title = createTitle.trim()
    if (!title) {
      return
    }
    setCreatingTask(true)
    setError('')
    try {
      if (provider === 'github' || provider === 'gitlab') {
        const repo = hostedRepos.find((entry) => entry.id === createRepoId) ?? hostedRepos[0]
        if (!repo) {
          throw new Error(
            `Add a Git repository before creating a ${provider === 'github' ? 'GitHub' : 'GitLab'} issue.`
          )
        }
        // Two providers, two methods: each arm sends its own operation rather than one call
        // picking a method string.
        const created =
          provider === 'github'
            ? githubIssueCreate.interpret(
                await githubIssueCreate.request(client, {
                  repo: `id:${repo.id}`,
                  title,
                  body: createBody
                })
              )
            : gitlabIssueCreate.interpret(
                await gitlabIssueCreate.request(client, {
                  repo: `id:${repo.id}`,
                  title,
                  body: createBody
                })
              )
        if (created.ok === false) {
          throw new Error(
            created.error ?? `Failed to create ${provider === 'github' ? 'GitHub' : 'GitLab'} issue`
          )
        }
        if (typeof created.number === 'number') {
          const createdAt = new Date().toISOString()
          if (provider === 'github') {
            setActionItem(
              createGitHubTask(repo, {
                id: `issue:${created.number}`,
                type: 'issue',
                number: created.number,
                title,
                state: 'open',
                url: created.url ?? '',
                labels: [],
                updatedAt: createdAt,
                author: null
              })
            )
          } else {
            setActionItem(
              createGitLabTask(repo, {
                id: `issue:${created.number}`,
                type: 'issue',
                number: created.number,
                title,
                state: 'opened',
                url: created.url ?? '',
                labels: [],
                updatedAt: createdAt,
                author: null
              })
            )
          }
        }
      } else {
        const team = linearTeams.find((entry) => entry.id === createTeamId) ?? linearTeams[0]
        if (!team) {
          throw new Error('Select a Linear team first.')
        }
        const reply = await linearIssueCreate.request(client, {
          teamId: team.id,
          title,
          description: createBody.trim() || undefined,
          workspaceId: team.workspaceId
        })
        const result = linearIssueCreate.interpret(reply)
        if (result.ok === false || !result.id || !result.identifier) {
          throw new Error(result.error ?? 'Failed to create Linear issue')
        }
        setActionItem(
          createLinearTask({
            id: result.id,
            workspaceId: team.workspaceId,
            workspaceName: team.workspaceName,
            identifier: result.identifier,
            title: result.title ?? title,
            description: createBody.trim(),
            url: result.url ?? '',
            state: { name: 'Open', type: 'unstarted', color: colors.accentBlue },
            team,
            labels: [],
            priority: 0,
            updatedAt: new Date().toISOString()
          }) as Extract<TaskItem, { provider: 'linear' }>
        )
      }
      setShowCreateTask(false)
      setCreateTitle('')
      setCreateBody('')
      await loadTasks({ silent: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task')
    } finally {
      setCreatingTask(false)
    }
  }, [
    client,
    createBody,
    createRepoId,
    createTeamId,
    createTitle,
    creatingTask,
    hostedRepos,
    linearTeams,
    loadTasks,
    provider,
    taskStateHydrated,
    tasksSupported
  ])

  const setGitHubIssueSourcePreference = useCallback(
    async (repo: RepoSummary, preference: 'upstream' | 'origin'): Promise<void> => {
      if (!client || !taskUiReady) {
        return
      }
      setError('')
      try {
        const reply = await taskRepoPreferenceWrite.request(
          client,
          {
            repo: `id:${repo.id}`,
            updates: { issueSourcePreference: preference }
          },
          { timeoutMs: 15_000 }
        )
        taskRepoPreferenceWrite.interpret(reply)
        // Why: the host owns issueSourcePreference, so re-read the list instead of
        // patching the cached copy and hoping the two stay in step.
        await repoListReload().catch(() => {})
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update issue source')
      }
    },
    [client, loadTasks, repoListReload, taskUiReady]
  )
  return Object.assign(model, { createTask, setGitHubIssueSourcePreference })
}

export type TaskCreateActionsModel = ReturnType<typeof useMobileTasksTaskCreateActions>
