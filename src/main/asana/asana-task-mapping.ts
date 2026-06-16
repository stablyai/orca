import type {
  AsanaApprovalStatus,
  AsanaComment,
  AsanaProject,
  AsanaTask,
  AsanaUser,
  AsanaWorkspace,
  AsanaWorkspaceSelection
} from '../../shared/types'

export type AsanaRecord = Record<string, unknown>

export const TASK_FIELDS = [
  'name',
  'notes',
  'permalink_url',
  'completed',
  'resource_subtype',
  'approval_status',
  'due_on',
  'assignee.name',
  'assignee.email',
  'assignee.photo.image_60x60',
  'assignee.photo.image_36x36',
  'projects.name',
  'created_at',
  'modified_at',
  'memberships.section.name'
].join(',')

export type AsanaListResponse = {
  data?: AsanaRecord[]
  next_page?: { offset?: string } | null
}

export type AsanaItemResponse = {
  data?: AsanaRecord
}

export function clampLimit(limit: number | undefined, fallback = 30): number {
  return Math.min(Math.max(1, Number.isFinite(limit) ? Number(limit) : fallback), 100)
}

export function shouldThrowAuthError(
  selection: AsanaWorkspaceSelection | null | undefined
): boolean {
  return selection !== 'all'
}

export function asRecord(value: unknown): AsanaRecord {
  return value && typeof value === 'object' ? (value as AsanaRecord) : {}
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asArray(value: unknown): AsanaRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : []
}

export function mapUser(value: unknown): AsanaUser | undefined {
  const user = asRecord(value)
  const gid = asString(user.gid)
  if (!gid) {
    return undefined
  }
  // Why: Asana's `photo` is null for users without a profile picture, and a
  // record of size variants otherwise — prefer 60px for a crisp small avatar.
  const photo = asRecord(user.photo)
  const photoUrl = asString(photo.image_60x60) || asString(photo.image_36x36) || undefined
  return {
    gid,
    name: asString(user.name, 'Unknown'),
    email: typeof user.email === 'string' ? user.email : undefined,
    photoUrl
  }
}

export function mapProject(value: unknown, workspace?: AsanaWorkspace): AsanaProject {
  const project = asRecord(value)
  return {
    gid: asString(project.gid),
    name: asString(project.name, 'Project'),
    workspaceId: workspace?.id,
    workspaceName: workspace?.name
  }
}

function mapSection(value: unknown): string | undefined {
  // Why: a task can belong to several projects; the first membership's section
  // is the most relevant "where does this sit" hint for the list view.
  const memberships = asArray(value)
  for (const membership of memberships) {
    const section = asRecord(membership.section)
    const name = asString(section.name)
    if (name) {
      return name
    }
  }
  return undefined
}

const APPROVAL_STATUSES = new Set<AsanaApprovalStatus>([
  'pending',
  'approved',
  'rejected',
  'changes_requested'
])

function mapApprovalStatus(value: unknown): AsanaApprovalStatus | null {
  return typeof value === 'string' && APPROVAL_STATUSES.has(value as AsanaApprovalStatus)
    ? (value as AsanaApprovalStatus)
    : null
}

export function mapAsanaTask(workspace: AsanaWorkspace, raw: AsanaRecord): AsanaTask {
  const gid = asString(raw.gid)
  return {
    gid,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    title: asString(raw.name, 'Untitled task'),
    description: asString(raw.notes) || undefined,
    url: asString(raw.permalink_url),
    completed: raw.completed === true,
    resourceSubtype: asString(raw.resource_subtype) || undefined,
    approvalStatus: mapApprovalStatus(raw.approval_status),
    dueOn: asString(raw.due_on) || null,
    assignee: mapUser(raw.assignee),
    projects: asArray(raw.projects).map((project) => mapProject(project, workspace)),
    section: mapSection(raw.memberships),
    createdAt: asString(raw.created_at, new Date().toISOString()),
    updatedAt: asString(raw.modified_at, new Date().toISOString())
  }
}

export function sortAndLimitTasks(tasks: AsanaTask[], limit: number): AsanaTask[] {
  // Why: parse each updatedAt once into a sort key rather than re-parsing both
  // operands on every comparator call (O(n log n) Date allocations otherwise).
  return tasks
    .map((task) => ({ task, ts: new Date(task.updatedAt).getTime() }))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map((entry) => entry.task)
}

export function mapComment(raw: AsanaRecord): AsanaComment {
  return {
    gid: asString(raw.gid),
    text: asString(raw.text),
    createdAt: asString(raw.created_at, new Date().toISOString()),
    user: mapUser(raw.created_by)
  }
}
