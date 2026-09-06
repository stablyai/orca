import type { LinearItemActionsModel } from './use-mobile-tasks-linear-item-actions'
import { colors, useCallback } from './mobile-tasks-dependencies'
import {
  type RepoSummary,
  type TaskItem,
  createGitHubTask,
  createGitLabTask,
  createLinearTask
} from './mobile-tasks-model'

export function useMobileTasksTaskCreateActions(model: LinearItemActionsModel) {
  const {
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
    taskLinearOperations,
    taskProviderWriteOperations,
    taskStateHydrated,
    taskUiReady,
    tasksSupported
  } = model
  const createTask = useCallback(async (): Promise<void> => {
    if (!tasksSupported || !taskStateHydrated || creatingTask) {
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
        if (!taskProviderWriteOperations) {
          throw new Error('Provider operations are unavailable.')
        }
        const repo = hostedRepos.find((entry) => entry.id === createRepoId) ?? hostedRepos[0]
        if (!repo) {
          throw new Error(
            `Add a Git repository before creating a ${provider === 'github' ? 'GitHub' : 'GitLab'} issue.`
          )
        }
        const result = await taskProviderWriteOperations.createIssue({
          provider,
          repoId: repo.id,
          title,
          body: createBody
        })
        if (typeof result.number === 'number') {
          const createdAt = new Date().toISOString()
          if (provider === 'github') {
            setActionItem(
              createGitHubTask(repo, {
                id: `issue:${result.number}`,
                type: 'issue',
                number: result.number,
                title,
                state: 'open',
                url: result.url ?? '',
                labels: [],
                updatedAt: createdAt,
                author: null
              })
            )
          } else {
            setActionItem(
              createGitLabTask(repo, {
                id: `issue:${result.number}`,
                type: 'issue',
                number: result.number,
                title,
                state: 'opened',
                url: result.url ?? '',
                labels: [],
                updatedAt: createdAt,
                author: null
              })
            )
          }
        }
      } else {
        if (!taskLinearOperations) {
          throw new Error('Linear operations are unavailable.')
        }
        const team = linearTeams.find((entry) => entry.id === createTeamId) ?? linearTeams[0]
        if (!team) {
          throw new Error('Select a Linear team first.')
        }
        const result = await taskLinearOperations.createIssue({
          team,
          title,
          description: createBody.trim() || undefined
        })
        setActionItem(
          createLinearTask({
            id: result.id,
            targetId: result.targetId,
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
    taskLinearOperations,
    taskProviderWriteOperations,
    tasksSupported
  ])
  const setGitHubIssueSourcePreference = useCallback(
    async (repo: RepoSummary, preference: 'upstream' | 'origin'): Promise<void> => {
      if (!taskProviderWriteOperations || !taskUiReady) {
        return
      }
      setError('')
      try {
        await taskProviderWriteOperations.updateIssueSource(repo.id, preference)
        // Why: the host owns issueSourcePreference, so re-read the list instead of
        // patching the cached copy and hoping the two stay in step.
        await repoListReload().catch(() => {})
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update issue source')
      }
    },
    [loadTasks, repoListReload, taskProviderWriteOperations, taskUiReady]
  )
  return Object.assign(model, {
    createTask,
    setGitHubIssueSourcePreference
  })
}

export type TaskCreateActionsModel = ReturnType<typeof useMobileTasksTaskCreateActions>
