import type { ProjectThreadReplyActionsModel } from './use-mobile-tasks-project-thread-reply-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  type GitHubIssueType,
  type GitHubProjectField,
  type GitHubProjectFieldMutationValue,
  type GitHubProjectRow,
  isSuccess,
  optimisticProjectFieldValue,
  splitRepositorySlug
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksProjectMetadataActions(model: ProjectThreadReplyActionsModel) {
  const {
    activeGitHubProjectHost,
    client,
    githubProjectTable,
    projectMutating,
    setGithubProjectTable,
    setProjectFieldDrafts,
    setProjectMutating,
    setProjectRowDetail,
    setProjectRowDetailError,
    setProjectRowItem
  } = model
  const mutateProjectRowMetadata = useCallback(
    async (
      row: GitHubProjectRow,
      updates: {
        addLabels?: string[]
        removeLabels?: string[]
        addAssignees?: string[]
        removeAssignees?: string[]
      }
    ): Promise<void> => {
      if (!client || projectMutating) {
        return
      }
      const slug = splitRepositorySlug(row.content.repository)
      if (!slug || !row.content.number) {
        setProjectRowDetailError('This project item cannot be edited from mobile.')
        return
      }
      setProjectMutating(true)
      try {
        const response = await client.sendRequest(
          'github.project.updateIssueBySlug',
          {
            owner: slug.owner,
            repo: slug.repo,
            host: activeGitHubProjectHost,
            number: row.content.number,
            updates
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: { message?: string } }
        if (result.ok === false) {
          throw new Error(result.error?.message ?? 'Failed to update GitHub item')
        }
        const applyContentUpdate = (candidate: GitHubProjectRow): GitHubProjectRow => {
          const labels = new Map(candidate.content.labels.map((label) => [label.name, label]))
          for (const label of updates.addLabels ?? []) {
            if (!labels.has(label)) {
              labels.set(label, { name: label, color: '808080' })
            }
          }
          for (const label of updates.removeLabels ?? []) {
            labels.delete(label)
          }
          const assignees = new Map(
            candidate.content.assignees.map((assignee) => [assignee.login, assignee])
          )
          for (const login of updates.addAssignees ?? []) {
            if (!assignees.has(login)) {
              assignees.set(login, { login, name: null })
            }
          }
          for (const login of updates.removeAssignees ?? []) {
            assignees.delete(login)
          }
          return {
            ...candidate,
            content: {
              ...candidate.content,
              labels: [...labels.values()],
              assignees: [...assignees.values()]
            }
          }
        }
        setProjectRowItem((current) =>
          current && current.id === row.id ? applyContentUpdate(current) : current
        )
        setGithubProjectTable((table) =>
          table
            ? {
                ...table,
                rows: table.rows.map((candidate) =>
                  candidate.id === row.id ? applyContentUpdate(candidate) : candidate
                )
              }
            : table
        )
        setProjectRowDetail((current) =>
          current?.provider === 'github'
            ? {
                ...current,
                labels: [
                  ...new Set([
                    ...current.labels.filter(
                      (label) => !(updates.removeLabels ?? []).includes(label)
                    ),
                    ...(updates.addLabels ?? [])
                  ])
                ],
                assignees: [
                  ...new Set([
                    ...current.assignees.filter(
                      (login) => !(updates.removeAssignees ?? []).includes(login)
                    ),
                    ...(updates.addAssignees ?? [])
                  ])
                ]
              }
            : current
        )
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to update item')
      } finally {
        setProjectMutating(false)
      }
    },
    [activeGitHubProjectHost, client, projectMutating]
  )

  const mutateProjectRowField = useCallback(
    async (
      row: GitHubProjectRow,
      field: GitHubProjectField,
      value: GitHubProjectFieldMutationValue | null
    ): Promise<void> => {
      if (!client || !githubProjectTable || projectMutating) {
        return
      }
      setProjectMutating(true)
      try {
        const response = await client.sendRequest(
          value === null ? 'github.project.clearItemField' : 'github.project.updateItemField',
          value === null
            ? {
                projectId: githubProjectTable.project.id,
                host: activeGitHubProjectHost,
                itemId: row.id,
                fieldId: field.id
              }
            : {
                projectId: githubProjectTable.project.id,
                host: activeGitHubProjectHost,
                itemId: row.id,
                fieldId: field.id,
                value
              },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: { message?: string } }
        if (result.ok === false) {
          throw new Error(result.error?.message ?? 'Failed to update project field')
        }
        const patchRow = (candidate: GitHubProjectRow): GitHubProjectRow => {
          const fieldValuesByFieldId = { ...candidate.fieldValuesByFieldId }
          if (value === null) {
            delete fieldValuesByFieldId[field.id]
          } else {
            fieldValuesByFieldId[field.id] = optimisticProjectFieldValue(field, value)
          }
          return { ...candidate, fieldValuesByFieldId }
        }
        setProjectRowItem((current) =>
          current && current.id === row.id ? patchRow(current) : current
        )
        setGithubProjectTable((table) =>
          table
            ? {
                ...table,
                rows: table.rows.map((candidate) =>
                  candidate.id === row.id ? patchRow(candidate) : candidate
                )
              }
            : table
        )
        if (value === null) {
          setProjectFieldDrafts((current) => ({ ...current, [field.id]: '' }))
        }
      } catch (err) {
        setProjectRowDetailError(
          err instanceof Error ? err.message : 'Failed to update project field'
        )
      } finally {
        setProjectMutating(false)
      }
    },
    [activeGitHubProjectHost, client, githubProjectTable, projectMutating]
  )

  const mutateProjectRowIssueType = useCallback(
    async (row: GitHubProjectRow, issueType: GitHubIssueType | null): Promise<void> => {
      if (!client || projectMutating) {
        return
      }
      const slug = splitRepositorySlug(row.content.repository)
      if (row.itemType !== 'ISSUE' || !slug || !row.content.number) {
        setProjectRowDetailError('This project issue type cannot be edited from mobile.')
        return
      }
      setProjectMutating(true)
      try {
        const response = await client.sendRequest(
          'github.project.updateIssueTypeBySlug',
          {
            owner: slug.owner,
            repo: slug.repo,
            host: activeGitHubProjectHost,
            number: row.content.number,
            issueTypeId: issueType?.id ?? null
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: { message?: string } }
        if (result.ok === false) {
          throw new Error(result.error?.message ?? 'Failed to update issue type')
        }
        const patchRow = (candidate: GitHubProjectRow): GitHubProjectRow => ({
          ...candidate,
          content: { ...candidate.content, issueType }
        })
        setProjectRowItem((current) =>
          current && current.id === row.id ? patchRow(current) : current
        )
        setGithubProjectTable((table) =>
          table
            ? {
                ...table,
                rows: table.rows.map((candidate) =>
                  candidate.id === row.id ? patchRow(candidate) : candidate
                )
              }
            : table
        )
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to update issue type')
      } finally {
        setProjectMutating(false)
      }
    },
    [activeGitHubProjectHost, client, projectMutating]
  )
  return Object.assign(model, {
    mutateProjectRowMetadata,
    mutateProjectRowField,
    mutateProjectRowIssueType
  })
}

export type ProjectMetadataActionsModel = ReturnType<typeof useMobileTasksProjectMetadataActions>
