// Desktop routes for org environments and their builds (Orca JWT, aud=orca-sandbox):
//   GET    /v1/environments                                   -> {environments, canAdmin}
//   POST   /v1/environments {name, repos, installScript?, envVarNames?, machineSize?} -> {environment}
//   GET    /v1/environments/:id                               -> {environment, builds, canAdmin}
//   PATCH  /v1/environments/:id {...fields, expectedRevision?}  -> {environment}
//   DELETE /v1/environments/:id                               -> {deleted: true}
//   POST   /v1/environments/:id/builds                        -> {build}
//   GET    /v1/environments/:id/builds/:bid                   -> {build}
//   GET    /v1/environments/:id/builds/:bid/events            -> ndjson stream (environment-builds.ts)
//   POST   /v1/environments/:id/builds/:bid/cancel | /activate -> {build} | {environment}
//   GET    /v1/environments/:id/staleness                     -> {staleness}
import type { SandboxCaller } from './auth'
import {
  activateBuild,
  advanceBuild,
  cancelBuild,
  getBuild,
  listBuilds,
  parseConfig,
  parseResult,
  pruneSnapshots,
  startBuild,
  streamBuildEvents,
  type BuildDeps,
  type BuildRow
} from './environment-builds'
import { checkStaleness } from './environment-staleness'
import {
  CreateEnvironmentSchema,
  EnvironmentError,
  UpdateEnvironmentSchema,
  canAdminEnvironments,
  createEnvironment,
  getEnvironment,
  listEnvironments,
  parseNames,
  parseRepos,
  requireAdmin,
  updateEnvironment,
  type EnvironmentRow
} from './environments'

const ROUTE = /^\/v1\/environments(?:\/(env_[0-9a-f]{8,40})(?:\/(staleness|builds)(?:\/(bld_[0-9a-f]{8,40})(?:\/(events|cancel|activate))?)?)?)?$/

export function isEnvironmentRoute(pathname: string): boolean {
  return pathname === '/v1/environments' || pathname.startsWith('/v1/environments/')
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

export function buildView(row: BuildRow, activeBuildId: string | null) {
  const config = parseConfig(row)
  const result = parseResult(row)
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    active: row.id === activeBuildId,
    createdBy: row.created_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    snapshotStartedAt: row.snapshot_started_at,
    finishedAt: row.finished_at,
    durationMs: row.finished_at !== null ? row.finished_at - row.created_at : null,
    // Rollback needs the snapshot; pruned builds keep their record and log only.
    activatable: row.status === 'succeeded' && row.snapshot_id !== null && row.snapshot_deleted_at === null,
    error: row.error,
    failedStep: row.failed_step,
    revision: config.revision,
    machineSize: config.machineSize,
    repos: config.repos.map((repo) => {
      const built = result?.repos?.find((r) => r.url === repo.url)
      return { url: repo.url, branch: built?.branch || repo.defaultBranch || null, commit: built?.commit || null }
    }),
    diskUsedBytes: result?.diskUsedBytes ?? null,
    diskTotalBytes: result?.diskTotalBytes ?? null,
    logBytes: row.log_bytes,
    logTruncated: row.log_truncated === 1
  }
}

export function environmentView(row: EnvironmentRow) {
  return {
    id: row.id,
    name: row.name,
    repos: parseRepos(row),
    installScript: row.install_script,
    envVarNames: parseNames(row),
    machineSize: row.machine_size,
    activeBuildId: row.active_build_id,
    revision: row.revision,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function handleEnvironmentRoute(
  request: Request,
  url: URL,
  caller: SandboxCaller,
  deps: BuildDeps,
  readJson: () => Promise<unknown>
): Promise<Response> {
  const match = ROUTE.exec(url.pathname)
  if (!match) {
    return json({ error: 'not_found' }, 404)
  }
  const [, envId, section, buildId, action] = match
  const { db } = deps
  const method = request.method
  const canAdmin = canAdminEnvironments(caller)
  if (!envId) {
    if (method === 'GET') {
      const rows = await listEnvironments(db, caller.accountId)
      const environments = []
      for (const row of rows) {
        const [latest] = await listBuilds(db, row.id, 1)
        const active = row.active_build_id ? await getBuild(db, row.id, row.active_build_id) : null
        environments.push({
          ...environmentView(row),
          activeBuild: active ? buildView(active, row.active_build_id) : null,
          latestBuild: latest ? buildView(latest, row.active_build_id) : null
        })
      }
      return json({ environments, canAdmin })
    }
    if (method === 'POST') {
      const body = CreateEnvironmentSchema.safeParse(await readJson())
      if (!body.success) {
        return json({ error: 'invalid_request', reason: body.error.issues[0]?.path.join('.') }, 400)
      }
      return json({ environment: environmentView(await createEnvironment(db, caller, body.data, deps.now())) })
    }
    return json({ error: 'not_found' }, 404)
  }
  const environment = await getEnvironment(db, caller.accountId, envId)
  if (!environment) {
    return json({ error: 'not_found' }, 404)
  }
  if (!section) {
    if (method === 'GET') {
      const builds = []
      for (const row of await listBuilds(db, envId, 30)) {
        builds.push(buildView(row, environment.active_build_id))
      }
      return json({ environment: environmentView(environment), builds, canAdmin })
    }
    if (method === 'PATCH') {
      const body = UpdateEnvironmentSchema.safeParse(await readJson())
      if (!body.success) {
        return json({ error: 'invalid_request', reason: body.error.issues[0]?.path.join('.') }, 400)
      }
      return json({ environment: environmentView(await updateEnvironment(db, caller, environment, body.data, deps.now())) })
    }
    if (method === 'DELETE') {
      requireAdmin(caller)
      for (const row of await listBuilds(db, envId, 1000)) {
        if (row.status === 'running' || row.status === 'starting') {
          await cancelBuild(deps, caller, row).catch(() => undefined)
        }
      }
      await db.prepare('UPDATE environments SET deleted_at = ?, active_build_id = NULL WHERE id = ?').bind(deps.now(), envId).run()
      // No kept window once deleted: every build snapshot goes (live workspaces run on their own disks).
      const { results } = await db
        .prepare(`SELECT * FROM environment_builds WHERE environment_id = ? AND snapshot_id IS NOT NULL AND snapshot_deleted_at IS NULL`)
        .bind(envId)
        .all<BuildRow>()
      for (const row of results) {
        await deps.provider.deleteSnapshot(row.snapshot_id!).catch(() => undefined)
        await db.prepare('UPDATE environment_builds SET snapshot_deleted_at = ? WHERE id = ?').bind(deps.now(), row.id).run()
      }
      return json({ deleted: true })
    }
    return json({ error: 'not_found' }, 404)
  }
  if (section === 'staleness' && method === 'GET') {
    return json({ staleness: await checkStaleness(deps, environment, url.searchParams.get('refresh') === '1') })
  }
  if (section !== 'builds') {
    return json({ error: 'not_found' }, 404)
  }
  if (!buildId) {
    if (method === 'POST') {
      const build = await startBuild(deps, caller, environment)
      return json({ build: buildView(build, environment.active_build_id) })
    }
    if (method === 'GET') {
      const builds = (await listBuilds(db, envId, 30)).map((row) => buildView(row, environment.active_build_id))
      return json({ builds })
    }
    return json({ error: 'not_found' }, 404)
  }
  let build = await getBuild(db, envId, buildId)
  if (!build) {
    return json({ error: 'not_found' }, 404)
  }
  const activeNow = async () => (await getEnvironment(db, caller.accountId, envId))?.active_build_id ?? null
  if (!action && method === 'GET') {
    build = await advanceBuild(deps, build)
    return json({ build: buildView(build, await activeNow()) })
  }
  if (action === 'events' && method === 'GET') {
    const stream = streamBuildEvents(deps, build, async (row) => buildView(row, await activeNow()), request.signal)
    return new Response(stream, {
      headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
    })
  }
  if (action === 'cancel' && method === 'POST') {
    build = await cancelBuild(deps, caller, build)
    return json({ build: buildView(build, await activeNow()) })
  }
  if (action === 'activate' && method === 'POST') {
    const updated = await activateBuild(db, caller, environment, build, deps.now())
    await pruneSnapshots(deps, envId)
    return json({ environment: environmentView(updated) })
  }
  return json({ error: 'not_found' }, 404)
}

export function environmentErrorResponse(error: EnvironmentError): Response {
  return json(error.reason ? { error: error.code, reason: error.reason } : { error: error.code }, error.status)
}
