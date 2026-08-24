import type {
  ShortcutMember,
  ShortcutStoryType,
  ShortcutTeam,
  ShortcutWorkflow,
  ShortcutWorkflowState,
  ShortcutWorkflowStateType
} from '../../shared/shortcut-types'

export type ShortcutRecord = Record<string, unknown>

export function asRecord(value: unknown): ShortcutRecord {
  return value && typeof value === 'object' ? (value as ShortcutRecord) : {}
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

// Shortcut public ids are numbers; workspace/member ids are UUID strings.
export function asIdentifier(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

export function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function mapStoryType(value: unknown): ShortcutStoryType {
  return value === 'bug' || value === 'chore' ? value : 'feature'
}

export function mapWorkflowStateType(value: unknown): ShortcutWorkflowStateType {
  if (value === 'unstarted' || value === 'done') {
    return value
  }
  return 'started'
}

export function mapWorkflowState(value: unknown): ShortcutWorkflowState | null {
  const state = asRecord(value)
  const id = asIdentifier(state.id)
  if (!id) {
    return null
  }
  return {
    id,
    name: asString(state.name, 'Unknown'),
    type: mapWorkflowStateType(state.type),
    position: asFiniteNumber(state.position) ?? 0,
    color: asString(state.color) || undefined
  }
}

export function mapWorkflow(value: unknown): ShortcutWorkflow | null {
  const workflow = asRecord(value)
  const id = asIdentifier(workflow.id)
  if (!id) {
    return null
  }
  const states = Array.isArray(workflow.states)
    ? workflow.states
        .map(mapWorkflowState)
        .filter((state): state is ShortcutWorkflowState => state !== null)
        .sort((a, b) => a.position - b.position)
    : []
  return {
    id,
    name: asString(workflow.name, 'Workflow'),
    defaultStateId: asIdentifier(workflow.default_state_id) || undefined,
    states
  }
}

export function mapMember(value: unknown): ShortcutMember | null {
  const member = asRecord(value)
  const profile = asRecord(member.profile)
  const id = asIdentifier(member.id)
  if (!id) {
    return null
  }
  const mentionName = asString(profile.mention_name) || undefined
  const icon = asRecord(profile.display_icon)
  return {
    id,
    name: asString(profile.name) || mentionName || 'Unknown',
    mentionName,
    email: asString(profile.email_address) || undefined,
    avatarUrl: asString(icon.url) || undefined
  }
}

export function mapTeam(value: unknown): ShortcutTeam | null {
  const team = asRecord(value)
  const id = asIdentifier(team.id)
  if (!id) {
    return null
  }
  const workflowIds = Array.isArray(team.workflow_ids)
    ? team.workflow_ids.map(asIdentifier).filter(Boolean)
    : []
  return {
    id,
    name: asString(team.name, 'Team'),
    defaultWorkflowId: asIdentifier(team.default_workflow_id) || undefined,
    workflowIds: workflowIds.length > 0 ? workflowIds : undefined
  }
}
