import {
  isEmptyLinearIssueAttributeFilter,
  type LinearIssueAttributeFilter
} from '../../shared/linear-issue-attribute-filter'
import type { LinearListFilter } from './issues'

// Why: attribute facets must merge into Linear's IssueFilter before the first-N
// cursor walk so hasMore reflects the filtered set, not the unfiltered window.
// @linear/sdk does not export IssueFilter as a public type, so we keep a
// structural subset that matches the operators this list path actually sends.

export type LinearGraphQLIssueFilter = {
  state?: {
    type?: { nin?: string[]; in?: string[] }
    id?: { in?: string[] }
  }
  team?: { id?: { eq?: string } }
  priority?: { in?: number[] }
  assignee?: { null?: boolean; id?: { eq?: string } }
  labels?: { some?: { id?: { in?: string[] } } }
}

const ACTIVE_STATE_FILTER: LinearGraphQLIssueFilter = {
  state: { type: { nin: ['completed', 'canceled'] } }
}
const COMPLETED_STATE_FILTER: LinearGraphQLIssueFilter = {
  state: { type: { in: ['completed', 'canceled'] } }
}

function listFilterForState(filter: LinearListFilter): LinearGraphQLIssueFilter | undefined {
  if (filter === 'assigned' || filter === 'created' || filter === 'open') {
    return ACTIVE_STATE_FILTER
  }
  if (filter === 'completed') {
    return COMPLETED_STATE_FILTER
  }
  return undefined
}

function attributeFacetFilter(
  attributeFilter: LinearIssueAttributeFilter | null | undefined
): LinearGraphQLIssueFilter | undefined {
  if (!attributeFilter || isEmptyLinearIssueAttributeFilter(attributeFilter)) {
    return undefined
  }

  const next: LinearGraphQLIssueFilter = {}

  if (attributeFilter.stateIds.length > 0) {
    next.state = { id: { in: attributeFilter.stateIds } }
  }

  if (attributeFilter.priorities.length > 0) {
    next.priority = { in: attributeFilter.priorities }
  }

  if (attributeFilter.assignee?.kind === 'unassigned') {
    next.assignee = { null: true }
  } else if (attributeFilter.assignee?.kind === 'user') {
    next.assignee = { id: { eq: attributeFilter.assignee.id } }
  }

  if (attributeFilter.labelIds.length > 0) {
    // Why: collection `some` is any-of; a direct labels.id comparator would
    // not express multi-label membership the same way.
    next.labels = { some: { id: { in: attributeFilter.labelIds } } }
  }

  return Object.keys(next).length > 0 ? next : undefined
}

function mergeIssueFilters(
  ...parts: (LinearGraphQLIssueFilter | undefined)[]
): LinearGraphQLIssueFilter | undefined {
  const defined = parts.filter((part): part is LinearGraphQLIssueFilter => part !== undefined)
  if (defined.length === 0) {
    return undefined
  }
  if (defined.length === 1) {
    return defined[0]
  }

  const merged: LinearGraphQLIssueFilter = {}
  for (const part of defined) {
    if (part.state) {
      // Why: preset state.type and attribute state.id must coexist; a top-level
      // spread would overwrite one nested constraint.
      merged.state = { ...merged.state, ...part.state }
    }
    if (part.team) {
      merged.team = part.team
    }
    if (part.priority) {
      merged.priority = part.priority
    }
    if (part.assignee) {
      merged.assignee = part.assignee
    }
    if (part.labels) {
      merged.labels = part.labels
    }
  }
  return merged
}

export function buildLinearListIssueFilter(options: {
  filter: LinearListFilter
  teamId?: string
  attributeFilter?: LinearIssueAttributeFilter | null
}): LinearGraphQLIssueFilter | undefined {
  const stateFilter = listFilterForState(options.filter)
  const teamFilter: LinearGraphQLIssueFilter | undefined = options.teamId
    ? { team: { id: { eq: options.teamId } } }
    : undefined
  const attributes = attributeFacetFilter(options.attributeFilter)
  return mergeIssueFilters(stateFilter, teamFilter, attributes)
}
