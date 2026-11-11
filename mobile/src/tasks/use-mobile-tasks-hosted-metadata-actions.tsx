import { githubTaskKey, sameGitHubTask, requireGitHubTaskTarget } from './github-task-identity'
import type { GitlabGithubStatusActionsModel } from './use-mobile-tasks-gitlab-github-status-actions'
import { useCallback } from './mobile-tasks-dependencies'
import type { TaskItem } from './mobile-tasks-legacy-foundation'
import {
  githubPullRequestUpdate,
  gitlabIssueUpdate,
  gitlabMergeRequestUpdate
} from './mobile-task-item-state-operations'

export type useMobileTasksHostedMetadataActionsInput = Pick<
  GitlabGithubStatusActionsModel,
  | 'claimPublication'
  | 'actionItem'
  | 'detailPayload'
  | 'client'
  | 'captureTaskListRefresh'
  | 'mutatingStatus'
  | 'setActionItem'
  | 'setDetailPayload'
  | 'setError'
  | 'setItemAddAssigneesDraft'
  | 'setItemAddLabelsDraft'
  | 'setItemRemoveAssigneesDraft'
  | 'setItemRemoveLabelsDraft'
  | 'setItems'
  | 'tryBeginMutation'
>

export function useMobileTasksHostedMetadataActions<
  Model extends useMobileTasksHostedMetadataActionsInput
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
  const updateGitHubPullRequestMetadata = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      updates: { title?: string; body?: string }
    ): Promise<void> => {
      if (!client || item.source.type !== 'pr') {
        return
      }
      const nextTitle = updates.title?.trim()
      if (updates.title !== undefined && !nextTitle) {
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
        const reply = await githubPullRequestUpdate.request(
          client,
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            prRepo: requireGitHubTaskTarget(item.source).repository,
            updates: {
              ...(nextTitle !== undefined ? { title: nextTitle } : {}),
              ...(updates.body !== undefined ? { body: updates.body } : {})
            }
          },
          { timeoutMs: 30_000 }
        )
        const result = githubPullRequestUpdate.interpret(reply)
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to update GitHub pull request')
        }
        refreshList()
        if (!isCurrent()) {
          return
        }
        if (nextTitle !== undefined) {
          setActionItem((current) =>
            sameGitHubTask(current, item)
              ? {
                  ...current,
                  title: nextTitle,
                  source: { ...current.source, title: nextTitle }
                }
              : current
          )
          setItems((current) =>
            current.map((candidate) =>
              sameGitHubTask(candidate, item)
                ? {
                    ...candidate,
                    title: nextTitle,
                    source: { ...candidate.source, title: nextTitle }
                  }
                : candidate
            )
          )
        }
        if (updates.body !== undefined) {
          setDetailPayload((current) =>
            current?.provider === 'github' && current.targetKey === githubTaskKey(item.source)
              ? { ...current, body: updates.body ?? '' }
              : current
          )
        }
      } catch (err) {
        if (!isCurrent()) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to update GitHub pull request')
      } finally {
        finish()
      }
    },
    [claimPublication, client, captureTaskListRefresh, tryBeginMutation]
  )

  const updateGitLabIssueMetadata = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'gitlab' }>,
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
      try {
        const updated =
          item.source.type === 'issue'
            ? gitlabIssueUpdate.interpret(
                await gitlabIssueUpdate.request(
                  client,
                  {
                    repo: `id:${item.source.repoId}`,
                    number: item.source.number,
                    updates,
                    projectRef: item.source.projectRef
                  },
                  { timeoutMs: 30_000 }
                )
              )
            : gitlabMergeRequestUpdate.interpret(
                await gitlabMergeRequestUpdate.request(
                  client,
                  {
                    repo: `id:${item.source.repoId}`,
                    iid: item.source.number,
                    projectRef: item.source.projectRef,
                    updates: {
                      title: updates.title,
                      body: updates.body,
                      addLabels: updates.addLabels,
                      removeLabels: updates.removeLabels
                    }
                  },
                  { timeoutMs: 30_000 }
                )
              )
        if (updated.ok === false) {
          throw new Error(updated.error ?? 'Failed to update GitLab item')
        }
        const nextLabels = [
          ...new Set([
            ...(detailPayload?.provider === 'gitlab'
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
          detailPayload?.provider === 'gitlab'
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
          current?.provider === 'gitlab' && current.source.id === item.source.id
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
            candidate.provider === 'gitlab' && candidate.source.id === item.source.id
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
          current?.provider === 'gitlab'
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
        if (item.source.type === 'issue') {
          setItemAddAssigneesDraft('')
          setItemRemoveAssigneesDraft('')
        }
        refreshList()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update GitLab item')
      } finally {
        finish()
      }
    },
    [claimPublication, client, detailPayload, captureTaskListRefresh, tryBeginMutation]
  )
  return Object.assign(model, { updateGitHubPullRequestMetadata, updateGitLabIssueMetadata })
}

export type HostedMetadataActionsModel = GitlabGithubStatusActionsModel &
  ReturnType<typeof useMobileTasksHostedMetadataActions>
