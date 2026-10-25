import type { JiraIssueUpdate, JiraSiteSelection } from '../../../shared/jira/jira-types'
import { isRecord } from '../../../shared/agent-status-child-work-value-guards'

export function normalizeJiraSiteId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function normalizeJiraSiteSelection(value: unknown): JiraSiteSelection | undefined {
  const siteId = normalizeJiraSiteId(value)
  return siteId
}

export function clampJiraIssueLimit(value: unknown, fallback = 30): number {
  const limit = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(Math.max(1, limit), 100)
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined
}

/** Narrows an untrusted IPC payload to the issue-update fields the host accepts. */
export function normalizeJiraIssueUpdate(value: unknown): JiraIssueUpdate | null {
  if (!isRecord(value)) {
    return null
  }
  const update: JiraIssueUpdate = {}
  if (value.title !== undefined) {
    if (typeof value.title !== 'string') {
      return null
    }
    update.title = value.title
  }
  if (value.labels !== undefined) {
    const labels = normalizeStringArray(value.labels)
    if (labels === undefined) {
      return null
    }
    update.labels = labels
  }
  if (value.labelOperations !== undefined) {
    const operations = value.labelOperations
    if (!isRecord(operations)) {
      return null
    }
    const add = normalizeStringArray(operations.add)
    const remove = normalizeStringArray(operations.remove)
    if (
      (operations.add !== undefined && add === undefined) ||
      (operations.remove !== undefined && remove === undefined)
    ) {
      return null
    }
    update.labelOperations = {
      ...(add !== undefined ? { add } : {}),
      ...(remove !== undefined ? { remove } : {})
    }
  }
  if (value.assigneeAccountId !== undefined) {
    if (value.assigneeAccountId !== null && typeof value.assigneeAccountId !== 'string') {
      return null
    }
    update.assigneeAccountId = value.assigneeAccountId
  }
  if (value.priorityId !== undefined) {
    if (value.priorityId !== null && typeof value.priorityId !== 'string') {
      return null
    }
    update.priorityId = value.priorityId
  }
  if (value.transitionId !== undefined) {
    if (typeof value.transitionId !== 'string') {
      return null
    }
    update.transitionId = value.transitionId
  }
  if (value.transitionFields !== undefined) {
    if (!isRecord(value.transitionFields)) {
      return null
    }
    update.transitionFields = value.transitionFields
  }
  if (value.transitionComment !== undefined) {
    if (typeof value.transitionComment !== 'string') {
      return null
    }
    update.transitionComment = value.transitionComment
  }
  return update
}
