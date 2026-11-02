import type {
  PlanePriority,
  PlaneStateGroup,
  PlaneUser
} from '../../shared/plane-types'

export type RawPlaneProject = {
  id: string
  identifier: string
  name: string
  description?: string
}

export type RawPlaneState = {
  id: string
  name: string
  group: string
  color: string
  sequence: number
}

export type RawPlaneUser = {
  id: string
  first_name?: string
  last_name?: string
  username?: string
  email?: string | null
  avatar?: string
}

export type RawPlaneIssue = {
  id: string
  sequence_id: number
  name: string
  description_html?: string
  description?: string
  project: string
  project_detail?: RawPlaneProject
  state: string
  state_detail?: RawPlaneState
  priority?: string
  labels_list?: { id: string; name: string }[]
  assignee_details?: RawPlaneUser[]
  created_at: string
  updated_at: string
}

export type RawPlaneComment = {
  id: string
  comment_html?: string
  comment_json?: { blocks?: { data?: { text?: string } }[] }
  actor_detail?: RawPlaneUser
  created_at: string
}

export function normalizeStateGroup(group: string): PlaneStateGroup {
  const normalized = group.toLowerCase()
  if (['backlog', 'unstarted', 'started', 'completed', 'cancelled'].includes(normalized)) {
    return normalized as PlaneStateGroup
  }
  return 'unstarted'
}

export function normalizePriority(raw?: string): PlanePriority {
  const lower = raw?.toLowerCase()
  if (lower === 'urgent' || lower === 'high' || lower === 'medium' || lower === 'low') {
    return lower
  }
  return 'none'
}

export function userFromRaw(raw?: RawPlaneUser): PlaneUser {
  if (!raw) {
    return { id: '', displayName: 'Unknown' }
  }
  const displayName =
    [raw.first_name, raw.last_name].filter(Boolean).join(' ') ||
    raw.username ||
    raw.email ||
    'Plane User'
  return {
    id: raw.id,
    displayName,
    email: raw.email ?? null,
    avatarUrl: raw.avatar
  }
}
