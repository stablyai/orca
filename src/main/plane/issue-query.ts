import type { getClient } from './client'
import type {
  PlaneIssueQuery,
  PlaneIssueSort,
  PlaneListFilter,
  PlaneWorkItem
} from '../../shared/plane/types'

type PlaneClient = ReturnType<typeof getClient>
type PlaneFilterClause = Record<string, string | number | boolean | string[] | number[] | null>
export type PlaneFilters = PlaneFilterClause | { and: PlaneFilterClause[] }

export function normalizeOrderBy(orderBy: PlaneIssueSort | undefined): PlaneIssueSort {
  return orderBy ?? '-updated_at'
}

export function buildPql(query: PlaneIssueQuery): string {
  const parts: string[] = []
  const preset = query.preset ?? 'all'
  if (preset === 'open' && !query.stateGroup) {
    parts.push('stateGroup IN (openStates())')
  }
  if (query.assigneeId === 'unassigned') {
    parts.push('hasNoAssignee()')
  }
  if (query.labelId === 'none') {
    parts.push('hasNoLabel()')
  }
  return parts.join(' AND ')
}

export function buildFilters(client: PlaneClient, query: PlaneIssueQuery): PlaneFilters | null {
  const clauses: PlaneFilterClause[] = []
  const preset = query.preset ?? 'all'
  if (preset === 'assigned' && client.instance.userId && query.assigneeId !== 'unassigned') {
    clauses.push({ assignee_id: client.instance.userId })
  } else if (preset === 'created' && client.instance.userId) {
    clauses.push({ created_by_id: client.instance.userId })
  } else if (preset === 'completed' && !query.stateGroup) {
    clauses.push({ state_group: 'completed' })
  }
  if (query.stateGroup) {
    clauses.push({ state_group: query.stateGroup })
  }
  if (query.stateId) {
    clauses.push({ state_id: query.stateId })
  }
  if (query.priority) {
    clauses.push({ priority: query.priority })
  }
  if (query.assigneeId && query.assigneeId !== 'unassigned') {
    clauses.push({ assignee_id: query.assigneeId })
  }
  if (query.labelId && query.labelId !== 'none') {
    clauses.push({ label_id: query.labelId })
  }
  if (query.cycleId === 'none') {
    clauses.push({ cycle_id: null })
  } else if (query.cycleId) {
    clauses.push({ cycle_id: query.cycleId })
  }
  if (query.moduleId === 'none') {
    clauses.push({ module_id: null })
  } else if (query.moduleId) {
    clauses.push({ module_id: query.moduleId })
  }
  if (query.typeId) {
    clauses.push({ type_id: query.typeId })
  }
  if (query.estimatePoint !== undefined) {
    clauses.push({ estimate_point: query.estimatePoint })
  }
  if (clauses.length === 0) {
    return null
  }
  return clauses.length === 1 ? clauses[0] : { and: clauses }
}

export function matchesListFilter(
  client: PlaneClient,
  issue: PlaneWorkItem,
  filter: PlaneListFilter
): boolean {
  if (filter === 'all') {
    return true
  }
  if (filter === 'completed') {
    return issue.state?.group === 'completed'
  }
  if (filter === 'open') {
    return issue.state?.group !== 'completed' && issue.state?.group !== 'cancelled'
  }
  if (filter === 'assigned') {
    return Boolean(client.instance.userId && issue.assigneeIds?.includes(client.instance.userId))
  }
  if (filter === 'created') {
    return Boolean(client.instance.userId && issue.createdById === client.instance.userId)
  }
  return true
}
