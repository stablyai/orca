import type { LinearMcpIssueListRequest } from '../../shared/linear/agent-access'

export function buildIssueFilter(request: LinearMcpIssueListRequest): Record<string, unknown> {
  const filter: Record<string, unknown> = {}
  if (request.team) {
    filter.team = namedFilter(request.team, true)
  }
  if (request.cycle) {
    filter.cycle = nullableNamedFilter(request.cycle)
  }
  if (request.label) {
    filter.labels = { some: namedFilter(request.label) }
  }
  if (request.query) {
    filter.searchableContent = { contains: request.query }
  }
  if (request.state) {
    filter.state = workflowStateFilter(request.state)
  }
  if (request.project) {
    filter.project = nullableProjectFilter(request.project)
  }
  if (request.release) {
    filter.releases = { some: namedFilter(request.release, false, true) }
  }
  if (request.assignee) {
    filter.assignee = nullableUserFilter(request.assignee)
  }
  if (request.delegate) {
    filter.delegate = nullableUserFilter(request.delegate)
  }
  if (request.parentId) {
    filter.parent = nullableIdFilter(request.parentId)
  }
  if (request.priority !== undefined) {
    filter.priority = { eq: request.priority }
  }
  if (request.createdAt) {
    filter.createdAt = { gte: request.createdAt }
  }
  if (request.updatedAt) {
    filter.updatedAt = { gte: request.updatedAt }
  }
  return filter
}

function namedFilter(value: string, includeKey = false, includeVersion = false): object {
  return {
    or: [
      ...(isLinearId(value) ? [{ id: { eq: value } }] : []),
      { name: { eqIgnoreCase: value } },
      ...(includeKey ? [{ key: { eqIgnoreCase: value } }] : []),
      ...(includeVersion ? [{ version: { eqIgnoreCase: value } }] : [])
    ]
  }
}

function nullableNamedFilter(value: string): object {
  return value === 'null' ? { null: true } : namedFilter(value)
}

function workflowStateFilter(value: string): object {
  const filter = namedFilter(value) as { or: object[] }
  filter.or.push({ type: { eqIgnoreCase: value } })
  return filter
}

function nullableProjectFilter(value: string): object {
  if (value === 'null') {
    return { null: true }
  }
  const filter = namedFilter(value) as { or: object[] }
  filter.or.push({ slugId: { eqIgnoreCase: value } })
  return filter
}

function nullableIdFilter(value: string): object {
  return value === 'null' ? { null: true } : { id: { eq: value } }
}

function nullableUserFilter(value: string): object {
  if (value === 'null') {
    return { null: true }
  }
  if (value.toLocaleLowerCase() === 'me') {
    return { isMe: { eq: true } }
  }
  return {
    or: [
      ...(isLinearId(value) ? [{ id: { eq: value } }] : []),
      { displayName: { eqIgnoreCase: value } },
      { name: { eqIgnoreCase: value } },
      { email: { eqIgnoreCase: value } }
    ]
  }
}

function isLinearId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
