import type { GlpiTicketFilter, GlpiWorkItemFilters } from '../../shared/types'

// GLPI Ticket search-query construction: field-id map plus the criterion
// builders that turn a filter scope and optional work-item filters into the
// /search/Ticket query string the REST API expects.

// Search-option field ids for Ticket (verified against the live GLPI schema).
const FIELD = {
  title: 1,
  id: 2,
  priority: 3,
  requester: 4,
  technician: 5,
  category: 7,
  urgency: 10,
  status: 12,
  type: 14,
  openDate: 15,
  updateDate: 19,
  followupCount: 27
} as const

const FORCE_DISPLAY = [
  FIELD.id,
  FIELD.title,
  FIELD.priority,
  FIELD.urgency,
  FIELD.status,
  FIELD.type,
  FIELD.openDate,
  FIELD.updateDate,
  FIELD.followupCount
]

export type SearchCriterion = {
  link?: 'AND' | 'OR'
  field: number
  searchtype: string
  value: string
}

export function buildSearchQuery(criteria: SearchCriterion[], limit: number): string {
  const parts: string[] = []
  criteria.forEach((criterion, index) => {
    if (criterion.link) {
      parts.push(`criteria[${index}][link]=${criterion.link}`)
    }
    parts.push(`criteria[${index}][field]=${criterion.field}`)
    parts.push(`criteria[${index}][searchtype]=${criterion.searchtype}`)
    parts.push(`criteria[${index}][value]=${encodeURIComponent(criterion.value)}`)
  })
  FORCE_DISPLAY.forEach((field, index) => {
    parts.push(`forcedisplay[${index}]=${field}`)
  })
  // Why: raw values keep status/type numeric (expand would localize them and
  // break the int→key mapping). Sort by last update, newest first.
  parts.push('expand_dropdowns=0')
  parts.push(`sort=${FIELD.updateDate}`)
  parts.push('order=DESC')
  parts.push(`range=0-${Math.max(0, limit - 1)}`)
  return parts.join('&')
}

export function filterCriteria(filter: GlpiTicketFilter, viewerId: number): SearchCriterion[] {
  // GLPI status pseudo-values: `notold` = open (new..pending), `old` = solved+closed.
  const statusValue = filter === 'closed' ? 'old' : 'notold'
  const criteria: SearchCriterion[] = [
    { field: FIELD.status, searchtype: 'equals', value: statusValue }
  ]
  if (filter === 'assigned') {
    criteria.push({
      link: 'AND',
      field: FIELD.technician,
      searchtype: 'equals',
      value: String(viewerId)
    })
  } else if (filter === 'created') {
    criteria.push({
      link: 'AND',
      field: FIELD.requester,
      searchtype: 'equals',
      value: String(viewerId)
    })
  }
  return criteria
}

// Each provided work-item filter field appends one AND-linked criterion so they
// combine with the base status/viewer scope from filterCriteria.
export function workItemFilterCriteria(filters: GlpiWorkItemFilters): SearchCriterion[] {
  const criteria: SearchCriterion[] = []
  if (filters.type) {
    criteria.push({
      link: 'AND',
      field: FIELD.type,
      searchtype: 'equals',
      value: filters.type === 'request' ? '2' : '1'
    })
  }
  const text = filters.text?.trim()
  if (text) {
    criteria.push({ link: 'AND', field: FIELD.title, searchtype: 'contains', value: text })
  }
  const category = filters.category?.trim()
  if (category) {
    criteria.push({ link: 'AND', field: FIELD.category, searchtype: 'contains', value: category })
  }
  if (typeof filters.priority === 'number' && Number.isFinite(filters.priority)) {
    criteria.push({
      link: 'AND',
      field: FIELD.priority,
      searchtype: 'equals',
      value: String(filters.priority)
    })
  }
  return criteria
}
