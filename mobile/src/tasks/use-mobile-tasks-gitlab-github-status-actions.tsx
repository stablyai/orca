import type { ProjectFileMergeActionsModel } from './use-mobile-tasks-project-file-merge-actions'
import { useCallback } from './mobile-tasks-dependencies'
import type { TaskItem } from './mobile-tasks-legacy-foundation'
import { taskItemMutationTarget } from './mobile-tasks-mutation-targets'

export function useMobileTasksGitlabGithubStatusActions(model: ProjectFileMergeActionsModel) {
  const {
    detailPayload,
    loadTasks,
    mutatingStatus,
    setActionItem,
    setDetailPayload,
    setError,
    setItemAddAssigneesDraft,
    setItemAddLabelsDraft,
    setItemRemoveAssigneesDraft,
    setItemRemoveLabelsDraft,
    setItems,
    setMutatingStatus,
    taskOperations
  } = model
  const toggleGitLabStatus = useCallback(
    async (item: Extract<TaskItem, { provider: 'gitlab' }>): Promise<void> => {
      if (!taskOperations || mutatingStatus || item.source.state === 'merged') {
        return
      }
      setMutatingStatus(true)
      setError('')
      const nextState = item.source.state === 'closed' ? 'opened' : 'closed'
      try {
        await taskOperations.itemMutation.setClosed(
          taskItemMutationTarget(item),
          nextState === 'closed'
        )
        setActionItem(null)
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update GitLab item')
      } finally {
        setMutatingStatus(false)
      }
    },
    [loadTasks, mutatingStatus, taskOperations]
  )

  const updateGitHubIssueMetadata = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      updates: {
        title?: string
        body?: string
        addLabels?: string[]
        removeLabels?: string[]
        addAssignees?: string[]
        removeAssignees?: string[]
      }
    ): Promise<void> => {
      if (!taskOperations || mutatingStatus) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        // Why `type: 'issue'` for PR rows too: labels and assignees only exist on GitHub's
        // issue endpoint, and the PR endpoint would silently drop them.
        await taskOperations.itemMutation.updateMetadata(
          { ...taskItemMutationTarget(item), type: 'issue' },
          updates
        )

        const nextLabels = [
          ...new Set([
            ...(detailPayload?.provider === 'github'
              ? detailPayload.labels.filter(
                  (label) => !(updates.removeLabels ?? []).includes(label)
                )
              : item.source.labels.filter(
                  (label) => !(updates.removeLabels ?? []).includes(label)
                )),
            ...(updates.addLabels ?? [])
          ])
        ]
        const nextAssignees =
          detailPayload?.provider === 'github'
            ? [
                ...new Set([
                  ...detailPayload.assignees.filter(
                    (login) => !(updates.removeAssignees ?? []).includes(login)
                  ),
                  ...(updates.addAssignees ?? [])
                ])
              ]
            : undefined
        const nextTitle = updates.title?.trim()
        setActionItem((current) =>
          current?.provider === 'github' && current.source.id === item.source.id
            ? {
                ...current,
                ...(nextTitle ? { title: nextTitle } : {}),
                source: {
                  ...current.source,
                  ...(nextTitle ? { title: nextTitle } : {}),
                  labels: nextLabels
                }
              }
            : current
        )
        setItems((current) =>
          current.map((candidate) =>
            candidate.provider === 'github' && candidate.source.id === item.source.id
              ? {
                  ...candidate,
                  ...(nextTitle ? { title: nextTitle } : {}),
                  source: {
                    ...candidate.source,
                    ...(nextTitle ? { title: nextTitle } : {}),
                    labels: nextLabels
                  }
                }
              : candidate
          )
        )
        setDetailPayload((current) =>
          current?.provider === 'github'
            ? {
                ...current,
                labels: nextLabels,
                ...(updates.body !== undefined ? { body: updates.body } : {}),
                ...(nextAssignees ? { assignees: nextAssignees } : {})
              }
            : current
        )
        setItemAddLabelsDraft('')
        setItemRemoveLabelsDraft('')
        setItemAddAssigneesDraft('')
        setItemRemoveAssigneesDraft('')
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update GitHub issue')
      } finally {
        setMutatingStatus(false)
      }
    },
    [detailPayload, loadTasks, mutatingStatus, taskOperations]
  )
  return Object.assign(model, { toggleGitLabStatus, updateGitHubIssueMetadata })
}

export type GitlabGithubStatusActionsModel = ReturnType<
  typeof useMobileTasksGitlabGithubStatusActions
>
