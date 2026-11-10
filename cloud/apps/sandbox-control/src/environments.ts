// Org environments ("Cloud Computer"): the repos, install script, env var names and machine size a
// team's cloud workspaces boot with. Builds (environment-builds.ts) turn one into a snapshot; the
// active build is what new workspaces boot from. Members read; owners/admins edit and build.
import { z } from 'zod'
import type { SandboxCaller } from './auth'
import type { MachineSize } from './entitlements'
import { parseGitHubRepo } from './github-app'
import { normalizeRepo } from './secrets'
import { MachineSizeInput } from './machine-size'

export const MAX_REPOS = 50
export const MAX_INSTALL_SCRIPT_CHARS = 20_000
/** D1 binds at most 100 parameters per query; the build's secret lookup binds one per name. */
export const MAX_ENV_VAR_NAMES = 50

export type EnvironmentRepo = { url: string; defaultBranch: string | null }

export type EnvironmentRow = {
  id: string
  account_id: string
  name: string
  repos: string
  install_script: string
  env_var_names: string
  machine_size: MachineSize
  active_build_id: string | null
  revision: number
  next_build_number: number
  created_by: string
  updated_by: string
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export class EnvironmentError extends Error {
  constructor(
    readonly code: 'not_found' | 'forbidden' | 'conflict' | 'invalid_request',
    readonly status: number,
    readonly reason?: string
  ) {
    super(reason ? `${code}:${reason}` : code)
    this.name = 'EnvironmentError'
  }
}

const Branch = z
  .string()
  .min(1)
  .max(255)
  .regex(/^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]+$/)

const RepoInput = z
  .object({ url: z.string().min(1).max(2048), defaultBranch: Branch.nullable().optional() })
  .strict()

const EnvVarName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/)

const ConfigFields = {
  name: z.string().trim().min(1).max(80),
  repos: z.array(RepoInput).max(MAX_REPOS),
  installScript: z.string().max(MAX_INSTALL_SCRIPT_CHARS),
  envVarNames: z.array(EnvVarName).max(MAX_ENV_VAR_NAMES),
  machineSize: MachineSizeInput
}

export const CreateEnvironmentSchema = z
  .object({
    ...ConfigFields,
    installScript: ConfigFields.installScript.default(''),
    envVarNames: ConfigFields.envVarNames.default([]),
    machineSize: ConfigFields.machineSize.default('standard')
  })
  .strict()

export const UpdateEnvironmentSchema = z
  .object({
    name: ConfigFields.name.optional(),
    repos: ConfigFields.repos.optional(),
    installScript: ConfigFields.installScript.optional(),
    envVarNames: ConfigFields.envVarNames.optional(),
    machineSize: ConfigFields.machineSize.optional(),
    /** Optimistic concurrency: refuse when someone else saved since this revision was read. */
    expectedRevision: z.number().int().positive().optional()
  })
  .strict()

/** Canonical `https://github.com/<owner>/<repo>.git`; accepts `owner/repo` and github URLs. */
export function canonicalRepoUrl(input: string): string | null {
  const trimmed = input.trim()
  const candidate = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(trimmed) ? `https://github.com/${trimmed}` : trimmed
  const parsed = parseGitHubRepo(candidate.replace(/^http:\/\//i, 'https://'))
  return parsed ? `https://github.com/${parsed.owner}/${parsed.repo}.git` : null
}

export function checkedRepos(input: z.infer<typeof RepoInput>[]): EnvironmentRepo[] {
  const seen = new Set<string>()
  const repos: EnvironmentRepo[] = []
  for (const repo of input) {
    const url = canonicalRepoUrl(repo.url)
    if (!url || /\/\.[^/]*\.git$/.test(url)) {
      throw new EnvironmentError('invalid_request', 400, 'repo_not_github')
    }
    const key = normalizeRepo(url)!
    if (seen.has(key)) {
      throw new EnvironmentError('invalid_request', 400, 'repo_duplicate')
    }
    seen.add(key)
    repos.push({ url, defaultBranch: repo.defaultBranch ?? null })
  }
  return repos
}

/** Where a repo is cloned under /vercel/sandbox/repos in a build (and linked as the project). */
export function repoDir(url: string): string {
  const parsed = parseGitHubRepo(url)
  return parsed ? `${parsed.owner}/${parsed.repo}` : 'repo'
}

export function canAdminEnvironments(caller: SandboxCaller): boolean {
  return !caller.orgId || caller.orgRole === 'owner' || caller.orgRole === 'admin' || caller.dev === true
}

export function requireAdmin(caller: SandboxCaller): void {
  if (!canAdminEnvironments(caller)) {
    throw new EnvironmentError('forbidden', 403, 'admin_required')
  }
}

export function parseRepos(row: Pick<EnvironmentRow, 'repos'>): EnvironmentRepo[] {
  try {
    return JSON.parse(row.repos) as EnvironmentRepo[]
  } catch {
    return []
  }
}

export function parseNames(row: Pick<EnvironmentRow, 'env_var_names'>): string[] {
  try {
    return JSON.parse(row.env_var_names) as string[]
  } catch {
    return []
  }
}

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

export function getEnvironment(db: D1Database, accountId: string, id: string): Promise<EnvironmentRow | null> {
  return db
    .prepare('SELECT * FROM environments WHERE id = ? AND account_id = ? AND deleted_at IS NULL')
    .bind(id, accountId)
    .first<EnvironmentRow>()
}

export async function listEnvironments(db: D1Database, accountId: string): Promise<EnvironmentRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM environments WHERE account_id = ? AND deleted_at IS NULL ORDER BY created_at')
    .bind(accountId)
    .all<EnvironmentRow>()
  return results
}

export async function createEnvironment(
  db: D1Database,
  caller: SandboxCaller,
  input: z.infer<typeof CreateEnvironmentSchema>,
  now: number
): Promise<EnvironmentRow> {
  requireAdmin(caller)
  const repos = checkedRepos(input.repos)
  const existing = await listEnvironments(db, caller.accountId)
  if (existing.length >= 20) {
    throw new EnvironmentError('conflict', 409, 'environment_limit')
  }
  if (existing.some((row) => row.name.toLowerCase() === input.name.toLowerCase())) {
    throw new EnvironmentError('conflict', 409, 'name_taken')
  }
  const id = randomId('env')
  await db
    .prepare(
      `INSERT INTO environments (id, account_id, name, repos, install_script, env_var_names, machine_size,
         revision, next_build_number, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`
    )
    .bind(id, caller.accountId, input.name, JSON.stringify(repos), input.installScript,
      JSON.stringify([...new Set(input.envVarNames)]), input.machineSize, caller.userId, caller.userId, now, now)
    .run()
  return (await getEnvironment(db, caller.accountId, id))!
}

export async function updateEnvironment(
  db: D1Database,
  caller: SandboxCaller,
  row: EnvironmentRow,
  input: z.infer<typeof UpdateEnvironmentSchema>,
  now: number
): Promise<EnvironmentRow> {
  requireAdmin(caller)
  if (input.expectedRevision !== undefined && input.expectedRevision !== row.revision) {
    throw new EnvironmentError('conflict', 409, 'stale_revision')
  }
  if (input.name && input.name.toLowerCase() !== row.name.toLowerCase()) {
    const taken = (await listEnvironments(db, caller.accountId)).some(
      (other) => other.id !== row.id && other.name.toLowerCase() === input.name!.toLowerCase()
    )
    if (taken) {
      throw new EnvironmentError('conflict', 409, 'name_taken')
    }
  }
  const next = {
    name: input.name ?? row.name,
    repos: input.repos ? JSON.stringify(checkedRepos(input.repos)) : row.repos,
    install_script: input.installScript ?? row.install_script,
    env_var_names: input.envVarNames ? JSON.stringify([...new Set(input.envVarNames)]) : row.env_var_names,
    machine_size: input.machineSize ?? row.machine_size
  }
  // A rename alone does not change what a build produces, so it keeps the revision.
  const buildInputsChanged =
    next.repos !== row.repos ||
    next.install_script !== row.install_script ||
    next.env_var_names !== row.env_var_names ||
    next.machine_size !== row.machine_size
  const result = await db
    .prepare(
      `UPDATE environments SET name = ?, repos = ?, install_script = ?, env_var_names = ?, machine_size = ?,
         revision = revision + ?, updated_by = ?, updated_at = ? WHERE id = ? AND revision = ?`
    )
    .bind(next.name, next.repos, next.install_script, next.env_var_names, next.machine_size,
      buildInputsChanged ? 1 : 0, caller.userId, now, row.id, row.revision)
    .run()
  if (result.meta.changes !== 1) {
    throw new EnvironmentError('conflict', 409, 'stale_revision')
  }
  return (await getEnvironment(db, caller.accountId, row.id))!
}

export type BootSource = {
  snapshotId: string
  environmentId: string
  buildId: string
  /** Directory under /vercel/sandbox/repos holding this workspace's repo, if the build has it. */
  repoDir: string | null
  machineSize: MachineSize
  /** The build's snapshot only boots here, so the workspace is created here too. */
  region: string
}

type BootBuildRow = {
  id: string
  environment_id: string
  region: string
  status: string
  snapshot_id: string | null
  snapshot_deleted_at: number | null
  result: string | null
  config: string
}

function bootFrom(build: BootBuildRow, repoUrl: string | null | undefined): BootSource | null {
  if (build.status !== 'succeeded' || !build.snapshot_id || build.snapshot_deleted_at !== null) {
    return null
  }
  const wanted = normalizeRepo(repoUrl)
  let dir: string | null = null
  try {
    const result = JSON.parse(build.result ?? '{}') as { repos?: { url: string; dir: string }[] }
    dir = result.repos?.find((repo) => normalizeRepo(repo.url) === wanted)?.dir ?? null
  } catch {
    dir = null
  }
  let machineSize: MachineSize = 'standard'
  try {
    machineSize = (JSON.parse(build.config) as { machineSize?: MachineSize }).machineSize ?? 'standard'
  } catch {
    // Default size.
  }
  return { snapshotId: build.snapshot_id, environmentId: build.environment_id, buildId: build.id, repoDir: dir, machineSize, region: build.region }
}

/**
 * What a new workspace boots from. `buildId`: exactly that build (it must belong to the account, have
 * succeeded and still have its snapshot). Otherwise the active build of the account's environment that
 * lists `repoUrl` (most recently edited first). Null means the plain golden image.
 */
export async function resolveEnvironmentBoot(
  db: D1Database,
  accountId: string,
  request: { repoUrl?: string | null; buildId?: string | null }
): Promise<BootSource | null> {
  if (request.buildId) {
    const build = await db
      .prepare(
        `SELECT b.* FROM environment_builds b JOIN environments e ON e.id = b.environment_id
         WHERE b.id = ? AND b.account_id = ? AND e.deleted_at IS NULL`
      )
      .bind(request.buildId, accountId)
      .first<BootBuildRow>()
    const source = build ? bootFrom(build, request.repoUrl) : null
    if (!source) {
      throw new EnvironmentError('not_found', 404, 'build_unavailable')
    }
    return source
  }
  const wanted = normalizeRepo(request.repoUrl)
  if (!wanted) {
    return null
  }
  const { results } = await db
    .prepare(
      `SELECT e.repos AS repos, b.* FROM environments e JOIN environment_builds b ON b.id = e.active_build_id
       WHERE e.account_id = ? AND e.deleted_at IS NULL ORDER BY e.updated_at DESC`
    )
    .bind(accountId)
    .all<BootBuildRow & { repos: string }>()
  for (const row of results) {
    if (!parseRepos(row).some((repo) => normalizeRepo(repo.url) === wanted)) {
      continue
    }
    const source = bootFrom(row, request.repoUrl)
    if (source?.repoDir) {
      return source
    }
  }
  return null
}
