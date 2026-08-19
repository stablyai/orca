import type { LinearCustomViewModel } from '../../shared/linear/project-types'
import type { LinearWorkspaceSelection } from '../../shared/linear/workspace-types'

export function normalizeWorkspaceId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function normalizeWorkspaceSelection(value: unknown): LinearWorkspaceSelection | undefined {
  const workspaceId = normalizeWorkspaceId(value)
  return workspaceId as LinearWorkspaceSelection | undefined
}

export function normalizeConcreteWorkspaceId(value: unknown): string {
  const workspaceId = normalizeWorkspaceId(value)
  if (!workspaceId || workspaceId === 'all') {
    throw new Error('Concrete Linear workspace ID is required')
  }
  return workspaceId
}

export function normalizeCustomViewModel(value: unknown): LinearCustomViewModel {
  if (value !== 'issue' && value !== 'project') {
    throw new Error('Custom view model is required')
  }
  return value
}

export function normalizeIdList(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (
    !Array.isArray(value) ||
    !value.every((id): id is string => typeof id === 'string' && Boolean(id.trim()))
  ) {
    throw new Error(`Invalid ${fieldName}`)
  }
  return value.map((id) => id.trim())
}

export function normalizeOptionalDate(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new Error(`Invalid ${fieldName}`)
  }
  return value.trim()
}
