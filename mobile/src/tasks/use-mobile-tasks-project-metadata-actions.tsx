import type { ProjectThreadReplyActionsModel } from './use-mobile-tasks-project-thread-reply-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  type GitHubIssueType,
  type GitHubProjectField,
  type GitHubProjectFieldMutationValue,
  type GitHubProjectRow,
  optimisticProjectFieldValue,
  projectRowIdentityTarget,
  projectRowMutationTarget
} from './mobile-tasks-model'

export function useMobileTasksProjectMetadataActions(model: ProjectThreadReplyActionsModel) {
  const {
    activeGitHubProjectHost,
    githubProjectTable,
    projectMutating,
    setGithubProjectTable,
    setProjectFieldDrafts,
    setProjectMutating,
    setProjectRowDetail,
    setProjectRowDetailError,
    setProjectRowItem,
    taskProjectMutationOperations
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
      if (!taskProjectMutationOperations || projectMutating) {
        return
      }
      const target = projectRowMutationTarget(row, activeGitHubProjectHost)
      if (!target) {
        setProjectRowDetailError('This project item cannot be edited from mobile.')
        return
      }
      setProjectMutating(true)
      try {
        await taskProjectMutationOperations.updateMetadata(target, updates)
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
    [activeGitHubProjectHost, projectMutating, taskProjectMutationOperations]
  )
  const mutateProjectRowField = useCallback(
    async (
      row: GitHubProjectRow,
      field: GitHubProjectField,
      value: GitHubProjectFieldMutationValue | null
    ): Promise<void> => {
      if (!taskProjectMutationOperations || !githubProjectTable || projectMutating) {
        return
      }
      // Why: the host addresses a field edit by project id + item id, so a draft row with no
      // repository slug, issue number or issue/PR kind is still editable.
      const target = projectRowIdentityTarget(row, activeGitHubProjectHost)
      setProjectMutating(true)
      try {
        await taskProjectMutationOperations.updateField(
          {
            ...target,
            projectId: githubProjectTable.project.id,
            itemId: row.id
          },
          field.id,
          value
        )
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
    [activeGitHubProjectHost, githubProjectTable, projectMutating, taskProjectMutationOperations]
  )
  const mutateProjectRowIssueType = useCallback(
    async (row: GitHubProjectRow, issueType: GitHubIssueType | null): Promise<void> => {
      if (!taskProjectMutationOperations || projectMutating) {
        return
      }
      const target = projectRowMutationTarget(row, activeGitHubProjectHost)
      if (row.itemType !== 'ISSUE' || !target || target.type !== 'issue') {
        setProjectRowDetailError('This project issue type cannot be edited from mobile.')
        return
      }
      setProjectMutating(true)
      try {
        await taskProjectMutationOperations.updateIssueType(target, issueType?.id ?? null)
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
    [activeGitHubProjectHost, projectMutating, taskProjectMutationOperations]
  )
  return Object.assign(model, {
    mutateProjectRowField,
    mutateProjectRowIssueType,
    mutateProjectRowMetadata
  })
}

export type ProjectMetadataActionsModel = ReturnType<typeof useMobileTasksProjectMetadataActions>
