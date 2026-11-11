// Automatic environments: Conductor-style "the repo is already there". An environment build (golden +
// the repo checked out, snapshotted) is opt-in for admins; without one every create of a repo cloned it
// from scratch (stablyai/orca: ~55 s). So the first create of a repo that no environment of the account
// lists makes a default environment for it (just the repo, blobless, no install script) and builds it in
// the background. Later creates boot from its active build (environments.ts resolveEnvironmentBoot) and
// only fetch what changed. Scoped per account like every environment; the usual golden refresh keeps
// it on the current image. Unused for 14 days it is deleted with its snapshots, unless an admin edited
// it (that makes it an ordinary 'org' environment).
import type { SandboxCaller } from './auth'
import { listBuilds, startBuild, TERMINAL, type BuildConfig, type BuildDeps } from './environment-builds'
import { canonicalRepoUrl, parseRepos, repoDir, type EnvironmentRow } from './environments'
import { normalizeRepo } from './secrets'

export const AUTO_ENVIRONMENT_USER = 'system:auto-environment'
export const AUTO_ENVIRONMENT_UNUSED_MS = 14 * 24 * 60 * 60_000
/** A failed automatic build is retried by a later create, at most this often. */
export const AUTO_RETRY_AFTER_MS = 60 * 60_000
/** Same cap as admin-made environments. */
const MAX_ENVIRONMENTS = 20

const log = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields }))

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  return `env_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

function systemCaller(accountId: string): SandboxCaller {
  // An org-less caller is its own admin (canAdminEnvironments); the build is billed to the account.
  return { userId: AUTO_ENVIRONMENT_USER, accountId }
}

function autoConfig(environment: EnvironmentRow): BuildConfig {
  return {
    revision: environment.revision,
    repos: parseRepos(environment),
    installScript: environment.install_script,
    envVarNames: [],
    machineSize: environment.machine_size,
    // History and trees only: a smaller snapshot and a faster build; file contents load on demand.
    cloneFilter: 'blob:none'
  }
}

export type AutoEnvironmentOutcome = 'created' | 'rebuilt' | 'exists' | 'skipped'

/**
 * A create of `repoUrl` booted without an environment: make (or retry building) the account's automatic
 * environment for it. Never throws; the create it rides behind already succeeded.
 */
export async function ensureAutoEnvironment(deps: BuildDeps, accountId: string, repoUrl: string): Promise<AutoEnvironmentOutcome> {
  try {
    return await ensure(deps, accountId, repoUrl)
  } catch (error) {
    log('auto_environment_failed', { error: String(error).slice(0, 200) })
    return 'skipped'
  }
}

async function ensure(deps: BuildDeps, accountId: string, repoUrl: string): Promise<AutoEnvironmentOutcome> {
  const url = canonicalRepoUrl(repoUrl)
  const wanted = normalizeRepo(url)
  if (!url || !wanted) {
    return 'skipped'
  }
  const { results: environments } = await deps.db
    .prepare('SELECT * FROM environments WHERE account_id = ? AND deleted_at IS NULL')
    .bind(accountId)
    .all<EnvironmentRow>()
  const listing = environments.filter((row) => parseRepos(row).some((repo) => normalizeRepo(repo.url) === wanted))
  if (listing.some((row) => row.kind !== 'auto')) {
    // An admin's environment lists the repo: theirs to build, never ours to shadow.
    return 'exists'
  }
  const auto = listing[0]
  if (auto) {
    await touchEnvironment(deps.db, auto.id, deps.now())
    return (await retryFailedBuild(deps, auto)) ? 'rebuilt' : 'exists'
  }
  if (environments.length >= MAX_ENVIRONMENTS) {
    return 'skipped'
  }
  const now = deps.now()
  const id = randomId()
  // UNIQUE(account_id, name): a concurrent first create of the same repo inserts nothing here.
  await deps.db
    .prepare(
      `INSERT OR IGNORE INTO environments (id, account_id, name, repos, install_script, env_var_names, machine_size,
         revision, next_build_number, created_by, updated_by, created_at, updated_at, kind, last_used_at)
       VALUES (?, ?, ?, ?, '', '[]', 'standard', 1, 1, ?, ?, ?, ?, 'auto', ?)`
    )
    .bind(id, accountId, repoDir(url), JSON.stringify([{ url, defaultBranch: null }]), AUTO_ENVIRONMENT_USER,
      AUTO_ENVIRONMENT_USER, now, now, now)
    .run()
  const environment = await deps.db
    .prepare('SELECT * FROM environments WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<EnvironmentRow>()
  if (!environment) {
    return 'exists'
  }
  const build = await startBuild(deps, systemCaller(accountId), environment, { config: autoConfig(environment) })
  log('auto_environment_created', { environmentId: id, buildId: build.id })
  return 'created'
}

/** No active build, none in flight, and the last one failed a while ago: try once more. */
async function retryFailedBuild(deps: BuildDeps, environment: EnvironmentRow): Promise<boolean> {
  if (environment.active_build_id) {
    return false
  }
  const [last] = await listBuilds(deps.db, environment.id, 1)
  if (last && (!TERMINAL.has(last.status) || deps.now() - (last.finished_at ?? last.created_at) < AUTO_RETRY_AFTER_MS)) {
    return false
  }
  await startBuild(deps, systemCaller(environment.account_id), environment, { config: autoConfig(environment) })
  return true
}

/** A create booted from (or asked for) this environment. */
export async function touchEnvironment(db: D1Database, environmentId: string, now: number): Promise<void> {
  await db.prepare('UPDATE environments SET last_used_at = ? WHERE id = ?').bind(now, environmentId).run()
}

/**
 * Deletes the environment and every snapshot it built (live workspaces run on their own disks).
 * Shared by an admin's Delete and the automatic expiry.
 */
export async function deleteEnvironmentAndSnapshots(
  deps: Pick<BuildDeps, 'db' | 'provider' | 'now'>,
  environmentId: string
): Promise<void> {
  await deps.db
    .prepare('UPDATE environments SET deleted_at = ?, active_build_id = NULL WHERE id = ?')
    .bind(deps.now(), environmentId)
    .run()
  const { results } = await deps.db
    .prepare(`SELECT id, snapshot_id FROM environment_builds WHERE environment_id = ? AND snapshot_id IS NOT NULL AND snapshot_deleted_at IS NULL`)
    .bind(environmentId)
    .all<{ id: string; snapshot_id: string }>()
  for (const row of results) {
    await deps.provider.deleteSnapshot(row.snapshot_id).catch(() => undefined)
    await deps.db.prepare('UPDATE environment_builds SET snapshot_deleted_at = ? WHERE id = ?').bind(deps.now(), row.id).run()
  }
}

/** Cron: automatic environments no create used for 14 days go, with their snapshots. */
export async function expireAutoEnvironments(deps: BuildDeps): Promise<number> {
  const cutoff = deps.now() - AUTO_ENVIRONMENT_UNUSED_MS
  const { results } = await deps.db
    .prepare(
      `SELECT id FROM environments WHERE kind = 'auto' AND deleted_at IS NULL
         AND COALESCE(last_used_at, created_at) < ? LIMIT 20`
    )
    .bind(cutoff)
    .all<{ id: string }>()
  let expired = 0
  for (const { id } of results) {
    const inFlight = (await listBuilds(deps.db, id, 5)).some((build) => !TERMINAL.has(build.status))
    if (inFlight) {
      continue
    }
    await deleteEnvironmentAndSnapshots(deps, id)
    log('auto_environment_expired', { environmentId: id })
    expired++
  }
  return expired
}
