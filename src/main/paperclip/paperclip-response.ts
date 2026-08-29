import type { PaperclipIssue } from '../../shared/paperclip-types'

export function parsePaperclipIssue(
  value: unknown,
  scope: { companyId: string; projectId?: string }
): PaperclipIssue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Paperclip returned an invalid issue.')
  }
  const issue = value as Record<string, unknown>
  const projectId = nullableString(issue.projectId)
  if (
    !nonEmpty(issue.id) ||
    !nonEmpty(issue.identifier) ||
    !nonEmpty(issue.title) ||
    issue.companyId !== scope.companyId ||
    (scope.projectId !== undefined && projectId !== scope.projectId)
  ) {
    throw new Error('Paperclip issue is missing or outside the bound connection scope.')
  }
  return {
    id: issue.id,
    identifier: issue.identifier,
    companyId: scope.companyId,
    projectId,
    title: issue.title,
    description: nullableString(issue.description),
    status: typeof issue.status === 'string' ? issue.status : 'unknown',
    priority: nullableString(issue.priority),
    checkoutRunId: nullableString(issue.checkoutRunId),
    executionRunId: nullableString(issue.executionRunId),
    executionLockedAt: nullableString(issue.executionLockedAt)
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}
