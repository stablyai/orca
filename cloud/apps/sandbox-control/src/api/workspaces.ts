// Workspace and project data access for the public API. A workspace is a sandbox row; the API adds
// a name, a project, an origin and archive/hidden flags on top of the desktop lifecycle.
import type { MachineSize } from '../entitlements'
import { createSandbox, destroySandbox, resumeSandbox, suspendSandbox, type LifecycleDeps } from '../lifecycle'
import { getSandbox, type SandboxRow } from '../store'
import { ApiError } from './caller'
import { randomId } from './keys'

export type WorkspaceOrigin = 'desktop' | 'api' | 'mcp' | 'routine' | 'vm'

export type WorkspaceRow = SandboxRow & {
  project_id: string | null
  name: string | null
  archived_at: number | null
  origin: WorkspaceOrigin | null
  origin_ref: string | null
  hidden: number
}

export type ProjectRow = {
  id: string
  account_id: string
  name: string
  repo_url: string | null
  default_ref: string | null
  machine_size: MachineSize
  region: string | null
  build_id: string | null
  created_by: string
  created_at: number
  updated_at: number
  archived_at: number | null
}

export function workspaceView(row: WorkspaceRow) {
  const session =
    row.session_id !== null && row.session_started_at !== null && row.lease_expires_at !== null
      ? { startedAt: row.session_started_at, leaseExpiresAt: row.lease_expires_at, deadlineAt: row.session_deadline_at }
      : null
  return {
    id: row.id,
    name: row.name ?? row.workspace_id,
    projectId: row.project_id,
    // `sleeping` is the API's word for a suspended VM: the disk is kept, nothing is billed.
    status: apiStatus(row),
    archived: row.archived_at !== null,
    hidden: row.hidden === 1,
    origin: row.origin ?? 'desktop',
    machineSize: row.machine_size,
    region: row.region,
    repoUrl: row.repo_url,
    session,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function apiStatus(row: Pick<SandboxRow, 'status'>): string {
  return (
    {
      creating: 'starting',
      running: 'running',
      suspending: 'sleeping',
      suspended: 'sleeping',
      resuming: 'waking',
      destroying: 'destroying',
      destroyed: 'destroyed',
      failed: 'failed'
    } as const
  )[row.status]
}

export function projectView(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    repo: row.repo_url ? { url: row.repo_url, ref: row.default_ref } : null,
    environment: { machineSize: row.machine_size, region: row.region, buildId: row.build_id },
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function getWorkspace(db: D1Database, accountId: string, id: string): Promise<WorkspaceRow> {
  const row = (await getSandbox(db, id)) as WorkspaceRow | null
  // Another account's workspace is indistinguishable from a missing one.
  if (!row || row.account_id !== accountId || row.status === 'destroyed') {
    throw new ApiError(404, 'not_found')
  }
  return row
}

export async function listWorkspaces(
  db: D1Database,
  accountId: string,
  options: { includeHidden: boolean; includeArchived: boolean; projectId?: string; originRef?: string; limit: number }
): Promise<WorkspaceRow[]> {
  const where = [`account_id = ?`, `status <> 'destroyed'`]
  const binds: (string | number)[] = [accountId]
  if (!options.includeHidden) {
    where.push('hidden = 0')
  }
  if (!options.includeArchived) {
    where.push('archived_at IS NULL')
  }
  if (options.projectId) {
    where.push('project_id = ?')
    binds.push(options.projectId)
  }
  if (options.originRef) {
    where.push('origin_ref = ?')
    binds.push(options.originRef)
  }
  const { results } = await db
    .prepare(`SELECT * FROM sandboxes WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
    .bind(...binds, options.limit)
    .all<WorkspaceRow>()
  return results
}

async function setWorkspaceMeta(
  db: D1Database,
  id: string,
  meta: { name: string | null; projectId: string | null; origin: WorkspaceOrigin; originRef: string | null; hidden: boolean }
): Promise<void> {
  await db
    .prepare('UPDATE sandboxes SET name = ?, project_id = ?, origin = ?, origin_ref = ?, hidden = ? WHERE id = ?')
    .bind(meta.name, meta.projectId, meta.origin, meta.originRef, meta.hidden ? 1 : 0, id)
    .run()
}

export async function createWorkspace(
  life: LifecycleDeps,
  caller: { accountId: string; userId: string },
  input: {
    name?: string
    project?: ProjectRow | null
    repo?: { url: string; ref?: string }
    machineSize?: MachineSize
    region?: string
    origin: WorkspaceOrigin
    originRef?: string | null
    hidden?: boolean
  }
): Promise<WorkspaceRow> {
  const repo = input.repo ?? (input.project?.repo_url ? { url: input.project.repo_url, ...(input.project.default_ref ? { ref: input.project.default_ref } : {}) } : undefined)
  const ready = await createSandbox(life, caller, {
    // The desktop keys sandboxes by its own workspace id; API workspaces get a fresh one.
    workspaceId: randomId(input.origin === 'routine' ? 'rtn' : 'api'),
    machineSize: input.machineSize ?? input.project?.machine_size ?? 'standard',
    ...((input.region ?? input.project?.region) ? { region: (input.region ?? input.project?.region)! } : {}),
    ...(repo ? { repo } : {})
  })
  await setWorkspaceMeta(life.db, ready.row.id, {
    name: input.name ?? null,
    projectId: input.project?.id ?? null,
    origin: input.origin,
    originRef: input.originRef ?? null,
    hidden: input.hidden ?? false
  })
  return (await getSandbox(life.db, ready.row.id)) as WorkspaceRow
}

export async function sleepWorkspace(life: LifecycleDeps, row: WorkspaceRow): Promise<WorkspaceRow> {
  if (row.status === 'suspended') {
    return row
  }
  return (await suspendSandbox(life, row)) as WorkspaceRow
}

export async function wakeWorkspace(life: LifecycleDeps, row: WorkspaceRow): Promise<WorkspaceRow> {
  const ready = await resumeSandbox(life, row)
  if (row.archived_at !== null) {
    // Waking an archived workspace brings it back.
    await life.db.prepare('UPDATE sandboxes SET archived_at = NULL WHERE id = ?').bind(row.id).run()
  }
  return (await getSandbox(life.db, ready.row.id)) as WorkspaceRow
}

/** Archive = sleep + out of default lists. The disk is kept until retention or destroy. */
export async function archiveWorkspace(life: LifecycleDeps, row: WorkspaceRow): Promise<WorkspaceRow> {
  const slept = row.status === 'running' ? await sleepWorkspace(life, row) : row
  await life.db.prepare('UPDATE sandboxes SET archived_at = COALESCE(archived_at, ?) WHERE id = ?').bind(life.now(), row.id).run()
  return (await getSandbox(life.db, slept.id)) as WorkspaceRow
}

export async function destroyWorkspace(life: LifecycleDeps, row: WorkspaceRow): Promise<WorkspaceRow> {
  return (await destroySandbox(life, row)) as WorkspaceRow
}

// Projects -------------------------------------------------------------------------------------

export async function listProjects(db: D1Database, accountId: string): Promise<ProjectRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM projects WHERE account_id = ? AND archived_at IS NULL ORDER BY name LIMIT 500')
    .bind(accountId)
    .all<ProjectRow>()
  return results
}

export async function getProject(db: D1Database, accountId: string, id: string): Promise<ProjectRow> {
  const row = await db.prepare('SELECT * FROM projects WHERE id = ? AND archived_at IS NULL').bind(id).first<ProjectRow>()
  if (!row || row.account_id !== accountId) {
    throw new ApiError(404, 'not_found')
  }
  return row
}

export async function insertProject(
  db: D1Database,
  input: Omit<ProjectRow, 'id' | 'created_at' | 'updated_at' | 'archived_at'>,
  now: number
): Promise<ProjectRow> {
  const id = randomId('prj')
  try {
    await db
      .prepare(
        `INSERT INTO projects (id, account_id, name, repo_url, default_ref, machine_size, region, build_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, input.account_id, input.name, input.repo_url, input.default_ref, input.machine_size, input.region,
        input.build_id, input.created_by, now, now)
      .run()
  } catch (error) {
    if (String(error).includes('UNIQUE')) {
      throw new ApiError(409, 'conflict', 'project_name_taken')
    }
    throw error
  }
  return (await db.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<ProjectRow>())!
}

export async function updateProject(
  db: D1Database,
  row: ProjectRow,
  patch: Partial<Pick<ProjectRow, 'name' | 'repo_url' | 'default_ref' | 'machine_size' | 'region' | 'build_id'>>,
  now: number
): Promise<ProjectRow> {
  const next = { ...row, ...patch }
  try {
    await db
      .prepare(
        `UPDATE projects SET name = ?, repo_url = ?, default_ref = ?, machine_size = ?, region = ?, build_id = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(next.name, next.repo_url, next.default_ref, next.machine_size, next.region, next.build_id, now, row.id)
      .run()
  } catch (error) {
    if (String(error).includes('UNIQUE')) {
      throw new ApiError(409, 'conflict', 'project_name_taken')
    }
    throw error
  }
  return { ...next, updated_at: now }
}

export async function archiveProject(db: D1Database, row: ProjectRow, now: number): Promise<void> {
  await db.prepare('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?').bind(now, now, row.id).run()
}
