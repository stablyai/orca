import type { PickerOption } from '../../../components/sheets/PickerModal'
import { translate } from '../../../i18n/mobile-i18n'
import { isClickUpStatusClosed } from '../../../../../src/shared/clickup/clickup-task-filter'
import type {
  ClickUpStatusOption,
  ClickUpTaskListFilter,
  ClickUpTaskScope
} from '../../../../../src/shared/clickup/clickup-types'

export const DEFAULT_CLICKUP_FILTER: ClickUpTaskListFilter = {
  scope: 'assigned',
  includeClosed: false
}

export function clickUpScopeLabel(scope: ClickUpTaskScope): string {
  return scope === 'all'
    ? translate('tasks.clickUp.scopeAll', 'All')
    : translate('tasks.clickUp.scopeAssigned', 'Assigned to me')
}

export const CLICKUP_SCOPE_OPTIONS: PickerOption<ClickUpTaskScope>[] = [
  {
    value: 'assigned',
    get label() {
      return clickUpScopeLabel('assigned')
    },
    get subtitle() {
      return translate('tasks.clickUp.scopeAssignedSubtitle', 'Tasks assigned to you')
    }
  },
  {
    value: 'all',
    get label() {
      return clickUpScopeLabel('all')
    },
    get subtitle() {
      return translate('tasks.clickUp.scopeAllSubtitle', 'Every task in the selected Workspace')
    }
  }
]

export function withClickUpStatuses(
  filter: ClickUpTaskListFilter,
  statuses: readonly string[]
): ClickUpTaskListFilter {
  return {
    scope: filter.scope,
    includeClosed: filter.includeClosed,
    ...(statuses.length > 0 ? { statuses: [...statuses] } : {})
  }
}

// An open-only list cannot hold a done status, so keeping one selected would show nothing.
export function toggleClickUpIncludeClosed(
  filter: ClickUpTaskListFilter,
  knownStatuses: readonly ClickUpStatusOption[]
): ClickUpTaskListFilter {
  const includeClosed = !filter.includeClosed
  const closedNames = new Set(knownStatuses.filter(isClickUpStatusClosed).map((s) => s.name))
  const statuses = (filter.statuses ?? []).filter((name) => includeClosed || !closedNames.has(name))
  return { ...withClickUpStatuses(filter, statuses), includeClosed }
}

export function toggleClickUpStatus(
  filter: ClickUpTaskListFilter,
  name: string
): ClickUpTaskListFilter {
  const selected = filter.statuses ?? []
  return withClickUpStatuses(
    filter,
    selected.includes(name) ? selected.filter((entry) => entry !== name) : [...selected, name]
  )
}

/** A search or a status that is selected stays offered even when the current rows no longer carry it. */
export function offeredClickUpStatuses(
  filter: ClickUpTaskListFilter,
  knownStatuses: readonly ClickUpStatusOption[]
): ClickUpStatusOption[] {
  const offered = filter.includeClosed
    ? [...knownStatuses]
    : knownStatuses.filter((status) => !isClickUpStatusClosed(status))
  const missing = (filter.statuses ?? []).filter(
    (name) => !offered.some((status) => status.name === name)
  )
  return [
    ...offered,
    ...missing.map((name) => ({ name, color: '', type: 'custom' as const, orderIndex: 0 }))
  ]
}

// Flat so it keys a cached list: filters that read different rows never share one.
export function clickUpFilterKey(filter: ClickUpTaskListFilter): string {
  return [
    filter.scope,
    filter.includeClosed ? 'closed' : 'open',
    [...(filter.statuses ?? [])].sort().join('\n')
  ].join('|')
}

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i

/** ClickUp colors are external text; only a plain hex value may reach a style. */
export function safeClickUpColor(color: string | undefined): string | undefined {
  return color && HEX_COLOR.test(color) ? color : undefined
}
