import { buildPlaneWorkItemUrl } from '../../shared/plane-work-item-url'
import {
  isPlaneStateGroup,
  isPlanePriority,
  type PlaneLabel,
  type PlaneMember,
  type PlanePriority,
  type PlaneProject,
  type PlaneState,
  type PlaneWorkItem,
  type PlaneWorkspace
} from '../../shared/plane-types'
import { planeHtmlToText } from './description-markdown'

export type PlaneWorkItemMappingContext = {
  workspace: PlaneWorkspace
  project: PlaneProject
  /** Fallback when a deployment ignores `expand` and returns bare ids. */
  stateById?: ReadonlyMap<string, PlaneState>
  labelById?: ReadonlyMap<string, PlaneLabel>
  memberById?: ReadonlyMap<string, PlaneMember>
}

/**
 * Returns null rather than throwing when the state cannot be resolved: one
 * unmappable row must not fail a whole list, and inventing a state group would
 * put the item in the wrong column.
 */
export function mapPlaneWorkItem(
  raw: unknown,
  context: PlaneWorkItemMappingContext
): PlaneWorkItem | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const record = raw as Record<string, unknown>
  const id = readString(record.id)
  const sequenceId = Number(record.sequence_id)
  // Why: parsePlaneWorkItemKey rejects non-positive and unsafe ids, so mapping
  // a looser value here would mint a key that later parsing refuses.
  if (!id || !Number.isSafeInteger(sequenceId) || sequenceId <= 0) {
    return null
  }
  const state = resolveState(record.state, context.stateById)
  if (!state) {
    return null
  }
  const key = `${context.project.identifier}-${sequenceId}`
  return {
    id,
    key,
    sequenceId,
    workspaceId: context.workspace.id,
    workspaceName: context.workspace.name,
    title: readString(record.name) ?? '(untitled)',
    description: planeHtmlToText(readString(record.description_html)),
    url: buildPlaneWorkItemUrl(context.workspace, key),
    project: context.project,
    state,
    labels: resolveLabels(record.labels, context.labelById),
    assignees: resolveMembers(record.assignees, context.memberById),
    priority: resolvePriority(record.priority),
    startDate: readString(record.start_date) ?? null,
    targetDate: readString(record.target_date) ?? null,
    createdAt: readString(record.created_at) ?? '',
    updatedAt: readString(record.updated_at) ?? ''
  }
}

export function mapPlaneState(raw: unknown): PlaneState | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const record = raw as Record<string, unknown>
  const id = readString(record.id)
  const group = record.group
  if (!id || !isPlaneStateGroup(group)) {
    return null
  }
  return {
    id,
    name: readString(record.name) ?? id,
    group,
    ...(readString(record.color) ? { color: readString(record.color) as string } : {}),
    ...(record.default === true ? { default: true } : {}),
    ...(Number.isFinite(Number(record.sequence)) ? { sequence: Number(record.sequence) } : {})
  }
}

export function mapPlaneProject(raw: unknown, workspace: PlaneWorkspace): PlaneProject | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const record = raw as Record<string, unknown>
  const id = readString(record.id)
  const identifier = readString(record.identifier)
  if (!id || !identifier) {
    return null
  }
  return {
    id,
    identifier: identifier.toUpperCase(),
    name: readString(record.name) ?? identifier,
    workspaceId: workspace.id,
    workspaceName: workspace.name
  }
}

export function mapPlaneLabel(raw: unknown): PlaneLabel | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const record = raw as Record<string, unknown>
  const id = readString(record.id)
  if (!id) {
    return null
  }
  return {
    id,
    name: readString(record.name) ?? id,
    ...(readString(record.color) ? { color: readString(record.color) as string } : {})
  }
}

export function mapPlaneMember(raw: unknown): PlaneMember | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const record = raw as Record<string, unknown>
  // Workspace member rows nest the user; expanded assignees are the user itself.
  const user = (record.member ?? record) as Record<string, unknown>
  const id = readString(user.id)
  if (!id) {
    return null
  }
  const first = readString(user.first_name)
  const last = readString(user.last_name)
  const email = readString(user.email)
  // `|| undefined` because join() yields '' for an empty name, and '' is not
  // nullish -- it would swallow the email and id fallbacks below.
  const fullName = [first, last].filter(Boolean).join(' ') || undefined
  const avatarUrl = readString(user.avatar_url) ?? readString(user.avatar)
  return {
    id,
    displayName: readString(user.display_name) ?? fullName ?? email ?? id,
    ...(email ? { email } : {}),
    ...(avatarUrl ? { avatarUrl } : {})
  }
}

function resolveState(
  value: unknown,
  stateById?: ReadonlyMap<string, PlaneState>
): PlaneState | null {
  const expanded = mapPlaneState(value)
  if (expanded) {
    return expanded
  }
  const id = readString(value)
  return id ? (stateById?.get(id) ?? null) : null
}

function resolveLabels(value: unknown, labelById?: ReadonlyMap<string, PlaneLabel>): PlaneLabel[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((entry) => mapPlaneLabel(entry) ?? labelById?.get(readString(entry) ?? '') ?? null)
    .filter((label): label is PlaneLabel => label !== null)
}

function resolveMembers(
  value: unknown,
  memberById?: ReadonlyMap<string, PlaneMember>
): PlaneMember[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((entry) => mapPlaneMember(entry) ?? memberById?.get(readString(entry) ?? '') ?? null)
    .filter((member): member is PlaneMember => member !== null)
}

function resolvePriority(value: unknown): PlanePriority {
  return isPlanePriority(value) ? value : 'none'
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}
