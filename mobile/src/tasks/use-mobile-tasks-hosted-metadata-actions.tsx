import type { GitlabGithubStatusActionsModel } from './use-mobile-tasks-gitlab-github-status-actions'
import { useCallback } from './mobile-tasks-dependencies'
import type { TaskItem } from './mobile-tasks-legacy-foundation'
import {
  githubPullRequestUpdate,
  gitlabIssueUpdate,
  gitlabMergeRequestUpdate
} from './mobile-task-item-state-operations'

export function useMobileTasksHostedMetadataActions(model: GitlabGithubStatusActionsModel) {
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
  const updateGitHubPullRequestMetadata = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      updates: { title?: string; body?: string }
    ): Promise<void> => {
      if (!client || mutatingStatus || item.source.type !== 'pr') {
        return
      }
      const nextTitle = updates.title?.trim()
      if (updates.title !== undefined && !nextTitle) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const reply = await githubPullRequestUpdate.request(
          client,
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            updates: {
              ...(nextTitle !== undefined ? { title: nextTitle } : {}),
              ...(updates.body !== undefined ? { body: updates.body } : {})
            }
          },
          { timeoutMs: 30_000 }
        )
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
        const result = githubPullRequestUpdate.interpret(reply) as {
          ok?: boolean
          error?: string
        }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to update GitHub pull request')
        }
        if (nextTitle !== undefined) {
          setActionItem((current) =>
            current?.provider === 'github' && current.source.id === item.source.id
              ? {
                  ...current,
                  title: nextTitle,
                  source: { ...current.source, title: nextTitle }
                }
              : current
          )
          setItems((current) =>
            current.map((candidate) =>
              candidate.provider === 'github' && candidate.source.id === item.source.id
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
            current?.provider === 'github' ? { ...current, body: updates.body ?? '' } : current
          )
        }
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update GitHub pull request')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, loadTasks, mutatingStatus]
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
      if (!client || mutatingStatus) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        // The method and its params were a pair of local ternaries over the item type, not a step
        // handed in at runtime, so each arm sends its own operation with its own params type.
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
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
        const result = updated as { ok?: boolean; error?: string }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to update GitLab item')
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
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update GitLab item')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, detailPayload, loadTasks, mutatingStatus]
  )
  return Object.assign(model, { updateGitHubPullRequestMetadata, updateGitLabIssueMetadata })
}

export type HostedMetadataActionsModel = ReturnType<typeof useMobileTasksHostedMetadataActions>
