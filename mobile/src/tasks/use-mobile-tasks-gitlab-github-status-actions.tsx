import type { ProjectFileMergeActionsModel } from './use-mobile-tasks-project-file-merge-actions'
import { useCallback } from './mobile-tasks-dependencies'
import type { TaskItem } from './mobile-tasks-legacy-foundation'
import {
  githubIssueUpdate,
  gitlabIssueUpdate,
  gitlabMergeRequestStateUpdate
} from './mobile-task-item-state-operations'

export function useMobileTasksGitlabGithubStatusActions(model: ProjectFileMergeActionsModel) {
  const {
    client,
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
    setMutatingStatus
  } = model
  const toggleGitLabStatus = useCallback(
    async (item: Extract<TaskItem, { provider: 'gitlab' }>): Promise<void> => {
      if (!client || mutatingStatus || item.source.state === 'merged') {
        return
      }
      setMutatingStatus(true)
      setError('')
      const nextState = item.source.state === 'closed' ? 'opened' : 'closed'
      try {
        // An issue edit and a merge-request state change are different methods, so each arm sends
        // its own operation rather than one call picking a method string.
        const updated =
          item.source.type === 'issue'
            ? gitlabIssueUpdate.interpret(
                await gitlabIssueUpdate.request(client, {
                  repo: `id:${item.source.repoId}`,
                  number: item.source.number,
                  updates: { state: nextState },
                  projectRef: item.source.projectRef
                })
              )
            : gitlabMergeRequestStateUpdate.interpret(
                await gitlabMergeRequestStateUpdate.request(client, {
                  repo: `id:${item.source.repoId}`,
                  iid: item.source.number,
                  state: nextState,
                  projectRef: item.source.projectRef
                })
              )
        const result = updated
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to update GitLab item')
        }
        setActionItem(null)
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update GitLab item')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, loadTasks, mutatingStatus]
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
      if (!client || mutatingStatus) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const reply = await githubIssueUpdate.request(
          client,
          {
            repo: `id:${item.source.repoId}`,
            number: item.source.number,
            updates
          },
          { timeoutMs: 30_000 }
        )
        const result = githubIssueUpdate.interpret(reply)
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to update GitHub issue')
        }

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
    [client, detailPayload, loadTasks, mutatingStatus]
  )
  return Object.assign(model, { toggleGitLabStatus, updateGitHubIssueMetadata })
}

export type GitlabGithubStatusActionsModel = ReturnType<
  typeof useMobileTasksGitlabGithubStatusActions
>
