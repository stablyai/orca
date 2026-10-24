import type { JiraIssueUpdate, JiraSiteSelection } from '../../../shared/jira/jira-types'

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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The following checks reject every host-accepted field with an invalid value.
  const input = value as JiraIssueUpdate
  if (input.title !== undefined && typeof input.title !== 'string') {
    return null
  }
  if (input.labels !== undefined && normalizeStringArray(input.labels) === undefined) {
    return null
  }
  if (input.labelOperations !== undefined) {
    const operations = input.labelOperations
    if (
      !operations ||
      typeof operations !== 'object' ||
      Array.isArray(operations) ||
      (operations.add !== undefined && normalizeStringArray(operations.add) === undefined) ||
      (operations.remove !== undefined && normalizeStringArray(operations.remove) === undefined)
    ) {
      return null
    }
  }
  if (
    input.assigneeAccountId !== undefined &&
    input.assigneeAccountId !== null &&
    typeof input.assigneeAccountId !== 'string'
  ) {
    return null
  }
  if (
    input.priorityId !== undefined &&
    input.priorityId !== null &&
    typeof input.priorityId !== 'string'
  ) {
    return null
  }
  if (input.transitionId !== undefined && typeof input.transitionId !== 'string') {
    return null
  }
  if (
    input.transitionFields !== undefined &&
    (input.transitionFields === null ||
      typeof input.transitionFields !== 'object' ||
      Array.isArray(input.transitionFields))
  ) {
    return null
  }
  if (input.transitionComment !== undefined && typeof input.transitionComment !== 'string') {
    return null
  }
  return input
}
