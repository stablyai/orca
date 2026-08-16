import { DASHBOARD_MAX_LABEL_LENGTH } from '../../shared/dashboard-snapshot'

const MAX_DASHBOARD_FILTER_OPTIONS = 500
const MAX_ID_LENGTH = 4_096

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0)
}

function isOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || isBoundedString(value, maxLength, true)
}

function isDashboardFilterOptionList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_DASHBOARD_FILTER_OPTIONS &&
    value.every((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return false
      }
      const option = entry as Record<string, unknown>
      return (
        isBoundedString(option.id, MAX_ID_LENGTH) &&
        isBoundedString(option.label, DASHBOARD_MAX_LABEL_LENGTH, true) &&
        isOptionalBoundedString(option.color, MAX_ID_LENGTH)
      )
    })
  )
}

export function isDashboardFilterOptions(value: unknown): boolean {
  if (value === undefined) {
    return true
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const options = value as Record<string, unknown>
  return (
    isDashboardFilterOptionList(options.projects) &&
    isDashboardFilterOptionList(options.workspaceStatuses)
  )
}
