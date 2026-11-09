import { durableDraftRowKey } from '../drafts/durable-draft-rows'
import { useDurableDraftField } from '../drafts/durable-draft-fields'
import { githubTaskKey } from './github-task-identity'
import type { ActionableTaskItem } from './mobile-tasks-project-workspace-types'
import type { GitHubProjectRow } from './mobile-tasks-view-state-types'

/** The item a status edit or refresh hands over as a new object is still the same item. */
export function taskItemIdentity(item: ActionableTaskItem): string {
  return item.provider === 'github' ? `github:${githubTaskKey(item.source)}` : item.key
}

// Tasks rows are host-scoped (`''` worktree part); the shell binds the host.
function taskCommentDraftKey(id: string | null): string | null {
  return id === null ? null : durableDraftRowKey('taskComment', '', id)
}

const TASK_CREATE_DRAFT_KEY = durableDraftRowKey('taskCreate', '', '')

/** The open item's comment box, kept per item. */
export function useTaskCommentDraft(item: ActionableTaskItem | null) {
  return useDurableDraftField(taskCommentDraftKey(item && taskItemIdentity(item)), 'text')
}

/** A GitHub project row's comment box, kept per row. */
export function useProjectRowCommentDraft(row: GitHubProjectRow | null) {
  return useDurableDraftField(taskCommentDraftKey(row && `githubProject:${row.id}`), 'text')
}

/** The New issue sheet's title and body, kept until a create succeeds and read only once the sheet opens. */
export function useTaskCreateDraft(open: boolean) {
  const key = open ? TASK_CREATE_DRAFT_KEY : null
  const [createTitle, setCreateTitle] = useDurableDraftField(key, 'title')
  const [createBody, setCreateBody] = useDurableDraftField(key, 'body')
  return { createTitle, setCreateTitle, createBody, setCreateBody }
}
