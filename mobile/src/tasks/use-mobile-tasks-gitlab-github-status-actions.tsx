import { withGitHubTargetOperation } from './github-work-item-operation'
import { githubTaskKey, sameGitHubTask, requireGitHubTaskTarget } from './github-task-identity'
import type { ProjectFileMergeActionsModel } from './use-mobile-tasks-project-file-merge-actions'
import { useCallback } from './mobile-tasks-dependencies'
import type { TaskItem } from './mobile-tasks-legacy-foundation'
import {
  githubIssueUpdate,
  gitlabIssueUpdate,
  gitlabMergeRequestStateUpdate
} from './mobile-task-item-state-operations'

export function useMobileTasksGitlabGithubStatusActions<
  Model extends Pick<
    ProjectFileMergeActionsModel,
    | 'claimPublication'
    | 'client'
    | 'detailPayload'
    | 'captureTaskListRefresh'
    | 'tryBeginMutation'
    | 'setActionItem'
    | 'setDetailPayload'
    | 'setError'
    | 'setItemAddAssigneesDraft'
    | 'setItemAddLabelsDraft'
    | 'setItemRemoveAssigneesDraft'
    | 'setItemRemoveLabelsDraft'
    | 'setItems'
  >
>(model: Model) {
  const {
    claimPublication,
    client,
    detailPayload,
    captureTaskListRefresh,
    tryBeginMutation,
    setActionItem,
    setDetailPayload,
    setError,
    setItemAddAssigneesDraft,
    setItemAddLabelsDraft,
    setItemRemoveAssigneesDraft,
    setItemRemoveLabelsDraft,
    setItems
  } = model
  const toggleGitLabStatus = useCallback(
    async (item: Extract<TaskItem, { provider: 'gitlab' }>): Promise<void> => {
      if (!client || item.source.state === 'merged') {
        return
      }
      const finish = tryBeginMutation()
      if (!finish) {
        return
      }
      const refreshList = captureTaskListRefresh()
      setError('')
      const nextState = item.source.state === 'closed' ? 'opened' : 'closed'
      try {
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
        if (updated.ok === false) {
          throw new Error(updated.error ?? 'Failed to update GitLab item')
        }
        setActionItem(null)
        refreshList()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update GitLab item')
      } finally {
        finish()
      }
    },
    [claimPublication, client, captureTaskListRefresh, tryBeginMutation]
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
      if (!client) {
        return
      }
      const finish = tryBeginMutation()
      if (!finish) {
        return
      }
      const refreshList = captureTaskListRefresh()
      setError('')
      const isCurrent = claimPublication(item)
      try {
        const target = requireGitHubTaskTarget(item.source)
        const params = { repo: `id:${item.source.repoId}`, number: item.source.number, updates }
        const reply = await withGitHubTargetOperation({
          client,
          params,
          ownerRepo: target.repository,
          send: (selected, exact, options) =>
            githubIssueUpdate.request(selected, { ...params, ...exact }, options)
        })
        const result = githubIssueUpdate.interpret(reply)
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to update GitHub issue')
        }

        refreshList()
        if (!isCurrent()) {
          return
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
          sameGitHubTask(current, item)
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
            sameGitHubTask(candidate, item)
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
          current?.provider === 'github' && current.targetKey === githubTaskKey(item.source)
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
      } catch (err) {
        if (!isCurrent()) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to update GitHub issue')
      } finally {
        finish()
      }
    },
    [claimPublication, client, detailPayload, captureTaskListRefresh, tryBeginMutation]
  )
  return Object.assign(model, { toggleGitLabStatus, updateGitHubIssueMetadata })
}

export type GitlabGithubStatusActionsModel = ProjectFileMergeActionsModel &
  ReturnType<typeof useMobileTasksGitlabGithubStatusActions>
