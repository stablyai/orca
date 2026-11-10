import { describe, expect, it } from 'vitest'
import { HostedSandboxReadyResponseSchema } from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { KEPT_BUILDS } from '../src/environment-builds'
import { GOLDEN, createHarness } from './harness'
import { lifecycleDeps, refreshEnvironmentsOnGolden } from '../src/index'
import { GOLDEN_REFRESH_USER } from '../src/environment-golden-refresh'

const REPO = 'https://github.com/acme/web.git'
const RESULT = JSON.stringify({
  durationSec: 3,
  repos: [{ url: REPO, dir: 'acme/web', branch: 'main', commit: 'a'.repeat(40), lockfiles: { 'pnpm-lock.yaml': 'b'.repeat(40) } }],
  diskUsedBytes: 3_000_000_000,
  diskTotalBytes: 34_000_000_000
})
const log = (data: string, stream = 'stdout') => `${JSON.stringify({ data, stream })}\n`

async function setup(githubFetch?: typeof fetch) {
  const h = await createHarness({}, githubFetch ? { githubFetch } : {})
  h.vercel.buildResult = RESULT
  const admin = await h.token('alice', 'acme', 'sandbox', { orgRole: 'admin' })
  const member = await h.token('bob', 'acme', 'sandbox', { orgRole: 'member' })
  const as = (bearer: string) => (method: string, path: string, body?: unknown) => h.call(method, path, { bearer, body })
  const adminCall = as(admin)
  const created = await adminCall('POST', '/v1/environments', {
    name: 'Default',
    repos: [{ url: 'acme/web', defaultBranch: 'main' }],
    installScript: 'pnpm install --frozen-lockfile',
    envVarNames: ['NPM_TOKEN']
  })
  expect(created.status).toBe(200)
  const envId: string = created.body.environment.id
  /** Starts a build and lets its VM command finish with `exitCode`. */
  async function build(exitCode: number, output = log('::orca-step:: install\nok\n')) {
    const started = await adminCall('POST', `/v1/environments/${envId}/builds`)
    expect(started.status).toBe(200)
    const command = [...h.vercel.buildCommands.values()].at(-1)!
    command.logs = output
    command.exitCode = exitCode
    h.advance(1000)
    const done = await adminCall('GET', `/v1/environments/${envId}/builds/${started.body.build.id}`)
    return done.body.build
  }
  return { h, adminCall, memberCall: as(member), envId, build }
}

describe('org environments', () => {
  it('validates config and lets only owners/admins change it', async () => {
    const { adminCall, memberCall, envId } = await setup()
    const env = (await memberCall('GET', `/v1/environments/${envId}`)).body
    expect(env.canAdmin).toBe(false)
    expect(env.environment.repos).toEqual([{ url: REPO, defaultBranch: 'main' }])
    expect((await memberCall('PATCH', `/v1/environments/${envId}`, { installScript: 'x' })).body).toEqual({ error: 'forbidden', reason: 'admin_required' })
    expect((await memberCall('POST', `/v1/environments/${envId}/builds`)).status).toBe(403)
    expect((await adminCall('PATCH', `/v1/environments/${envId}`, { repos: [{ url: 'https://gitlab.com/a/b' }] })).body.reason).toBe('repo_not_github')
    expect((await adminCall('PATCH', `/v1/environments/${envId}`, { envVarNames: ['lower'] })).status).toBe(400)
    const renamed = await adminCall('PATCH', `/v1/environments/${envId}`, { name: 'Main', expectedRevision: 1 })
    expect(renamed.body.environment.revision).toBe(1)
    const edited = await adminCall('PATCH', `/v1/environments/${envId}`, { installScript: 'npm ci', expectedRevision: 1 })
    expect(edited.body.environment.revision).toBe(2)
    expect((await adminCall('PATCH', `/v1/environments/${envId}`, { installScript: 'x', expectedRevision: 1 })).body.reason).toBe('stale_revision')
  })

  it('builds, activates on success, and keeps the last good build when a build fails', async () => {
    const { h, adminCall, envId, build } = await setup()
    const first = await build(0)
    expect(first).toMatchObject({ number: 1, status: 'succeeded', active: true, activatable: true })
    expect(first.repos[0].commit).toBe('a'.repeat(40))
    const box = [...h.vercel.boxes.keys()]
    expect(box.some((name) => name.includes('envbuild'))).toBe(false)
    const command = [...h.vercel.buildCommands.values()][0]!
    expect(command.env.ORCA_BUILD_REPOS).toBe(`${REPO}|main|acme/web|`)
    expect(Buffer.from(command.env.ORCA_INSTALL_SCRIPT_B64!, 'base64').toString()).toBe('pnpm install --frozen-lockfile')

    const failed = await build(20, log('::orca-step:: install\n::orca-error:: The install script exited with status 1.\n'))
    expect(failed).toMatchObject({ number: 2, status: 'failed', error: 'install_failed', failedStep: 'install', active: false })
    const env = (await adminCall('GET', `/v1/environments/${envId}`)).body
    expect(env.environment.activeBuildId).toBe(first.id)
    // The stored log replays through the events stream.
    const events = await h.send(new Request(`https://sandbox.test/v1/environments/${envId}/builds/${failed.id}/events`, {
      headers: { authorization: `Bearer ${await h.token('alice', 'acme', 'sandbox', { orgRole: 'admin' })}` }
    }))
    const lines = (await events.text()).trim().split('\n').map((line) => JSON.parse(line))
    expect(lines[0]).toMatchObject({ type: 'build', build: { status: 'failed' } })
    expect(lines.filter((e) => e.type === 'log').map((e) => e.data).join('')).toContain('::orca-error::')
    expect(lines.at(-1)).toEqual({ type: 'end' })
  })

  it('fails a build whose image cannot start orcad, keeping the active one', async () => {
    const { h, adminCall, envId, build } = await setup()
    const good = await build(0)
    h.vercel.failStart = true
    const broken = await build(0)
    expect(broken).toMatchObject({ status: 'failed', error: 'smoke_failed', failedStep: 'snapshot', activatable: false })
    expect((await adminCall('GET', `/v1/environments/${envId}`)).body.environment.activeBuildId).toBe(good.id)
    expect([...h.vercel.boxes.keys()].filter((name) => name.includes('envbuild'))).toEqual([])
  })

  it('bills build sandbox time to the member who started it, retrying when billing is down, and refuses blocked orgs', async () => {
    const { h, adminCall, envId, build } = await setup()
    await adminCall('PATCH', `/v1/environments/${envId}`, { machineSize: 'large' })
    h.billing.down = true
    const first = await build(0)
    expect(h.billing.usage).toEqual([])
    const unreported = h.raw.prepare('SELECT usage_reported_at FROM environment_builds WHERE id = ?').get(first.id) as { usage_reported_at: number | null }
    expect(unreported.usage_reported_at).toBeNull()
    h.billing.down = false
    const { advanceAllBuilds } = await import('../src/environment-builds')
    await advanceAllBuilds({
      db: h.env.SANDBOX_DB,
      provider: h.vercel,
      entitlements: { checkStart: async () => h.billing.decision, reportUsage: async (s) => { h.billing.usage.push(s); return h.billing.usageAnswer }, listSuspensions: async () => [] },
      now: h.now,
      config: { environment: 'test', goldenSnapshotId: 'snap_golden', region: 'iad1' }
    })
    expect(h.billing.usage).toEqual([
      expect.objectContaining({ usageId: `build:${first.id}`, sandboxId: first.id, machineSize: 'standard', userId: 'alice', accountId: 'org:acme' })
    ])
    const failed = await build(20)
    expect(h.billing.usage.at(-1)).toMatchObject({ usageId: `build:${failed.id}`, userId: 'alice' })
    const usage = h.billing.usage.at(-1)!
    expect(usage.endedAt).toBeGreaterThan(usage.startedAt)
    // Out of sandbox hours / payment failed: builds are refused like starts.
    h.billing.decision = { allow: false, reason: 'hours_exhausted', suspendRunning: false }
    const refused = await adminCall('POST', `/v1/environments/${envId}/builds`)
    expect(refused.status).toBe(403)
    expect(refused.body.reason).toBe('hours_exhausted')
  })

  it('finishes a build server-side with nobody streaming or polling it (regression: W9 poll-only stall)', async () => {
    const scheduled: { id: string; environmentId: string }[] = []
    const h = await createHarness({}, { scheduleBuild: async (build) => void scheduled.push(build) })
    h.vercel.buildResult = RESULT
    const admin = await h.token('alice', 'acme', 'sandbox', { orgRole: 'admin' })
    const env = await h.call('POST', '/v1/environments', { bearer: admin, body: { name: 'Default', repos: [{ url: 'acme/web' }], installScript: 'echo hi' } })
    const started = await h.call('POST', `/v1/environments/${env.body.environment.id}/builds`, { bearer: admin })
    expect(started.body.build.status).toBe('running')
    // The build is handed to its runner at start; no reader ever looks at it again.
    expect(scheduled).toEqual([{ id: started.body.build.id, environmentId: env.body.environment.id }])
    const { tickBuild, unfinishedBuilds } = await import('../src/environment-builds')
    const deps = {
      db: h.env.SANDBOX_DB,
      provider: h.vercel,
      entitlements: { checkStart: async () => h.billing.decision, reportUsage: async (s: never) => { h.billing.usage.push(s); return h.billing.usageAnswer }, listSuspensions: async () => [] },
      now: h.now,
      config: { environment: 'test', goldenSnapshotId: 'snap_golden', region: 'iad1' }
    }
    // While the VM command runs, the runner keeps a short cadence.
    expect(await tickBuild(deps, env.body.environment.id, started.body.build.id)).toBe(3_000)
    expect(await unfinishedBuilds(h.env.SANDBOX_DB)).toHaveLength(1)
    const command = [...h.vercel.buildCommands.values()].at(-1)!
    command.logs = log('::orca-step:: install\nhi\n')
    command.exitCode = 0
    h.advance(3_000)
    // The next alarm finalizes it (snapshot, smoke boot, activation, billing) and stops.
    expect(await tickBuild(deps, env.body.environment.id, started.body.build.id)).toBeNull()
    const row = h.raw.prepare('SELECT status, usage_reported_at, log_bytes FROM environment_builds WHERE id = ?').get(started.body.build.id) as {
      status: string
      usage_reported_at: number | null
      log_bytes: number
    }
    expect(row.status).toBe('succeeded')
    expect(row.usage_reported_at).not.toBeNull()
    expect(row.log_bytes).toBeGreaterThan(0)
    expect(await unfinishedBuilds(h.env.SANDBOX_DB)).toEqual([])
    const environment = (await h.call('GET', `/v1/environments/${env.body.environment.id}`, { bearer: admin })).body.environment
    expect(environment.activeBuildId).toBe(started.body.build.id)
  })

  it('refuses a second concurrent build and can cancel one', async () => {
    const { adminCall, envId } = await setup()
    const started = await adminCall('POST', `/v1/environments/${envId}/builds`)
    expect((await adminCall('POST', `/v1/environments/${envId}/builds`)).body.reason).toBe('build_in_progress')
    const canceled = await adminCall('POST', `/v1/environments/${envId}/builds/${started.body.build.id}/cancel`)
    expect(canceled.body.build.status).toBe('canceled')
    expect((await adminCall('POST', `/v1/environments/${envId}/builds`)).status).toBe(200)
  })

  it('adopts the snapshot of a finalize that was cut off mid-snapshot', async () => {
    const { h, adminCall, envId } = await setup()
    const started = await adminCall('POST', `/v1/environments/${envId}/builds`)
    const command = [...h.vercel.buildCommands.values()].at(-1)!
    command.exitCode = 0
    const createSnapshot = h.vercel.createSnapshot
    // The provider makes the snapshot, but this Worker never hears back (ctx.waitUntil cut-off).
    h.vercel.createSnapshot = async (sessionId, expirationMs) => {
      await createSnapshot(sessionId, expirationMs)
      return new Promise<string>(() => undefined)
    }
    void adminCall('GET', `/v1/environments/${envId}/builds/${started.body.build.id}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    h.vercel.createSnapshot = createSnapshot
    expect((await adminCall('GET', `/v1/environments/${envId}/builds/${started.body.build.id}`)).body.build.status).toBe('snapshotting')
    h.advance(4 * 60_000)
    const recovered = (await adminCall('GET', `/v1/environments/${envId}/builds/${started.body.build.id}`)).body.build
    expect(recovered).toMatchObject({ status: 'succeeded', active: true, activatable: true })
    expect(recovered.repos[0].commit).toBe('a'.repeat(40))
  })

  it('cancels a running build without waiting for its log to end', async () => {
    const { h, adminCall, envId } = await setup()
    const started = await adminCall('POST', `/v1/environments/${envId}/builds`)
    const command = [...h.vercel.buildCommands.values()].at(-1)!
    // A live command's log never ends.
    h.vercel.streamCommandLogs = async () =>
      new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode(log('still installing\n'))) })
    const t = Date.now()
    const canceled = await adminCall('POST', `/v1/environments/${envId}/builds/${started.body.build.id}/cancel`)
    expect(canceled.body.build).toMatchObject({ status: 'canceled', error: 'canceled' })
    expect(Date.now() - t).toBeLessThan(8_000)
    expect(canceled.body.build.logBytes).toBeGreaterThan(0)
    expect(command.exitCode).toBeNull()
  }, 15_000)

  it('streams a running build live and finalizes it when the command ends', async () => {
    const { h, adminCall, envId } = await setup()
    const started = await adminCall('POST', `/v1/environments/${envId}/builds`)
    const command = [...h.vercel.buildCommands.values()].at(-1)!
    command.logs = log('::orca-step:: clone\n') + log('Cloning\n')
    command.exitCode = 0
    const events = await h.send(new Request(`https://sandbox.test/v1/environments/${envId}/builds/${started.body.build.id}/events`, {
      headers: { authorization: `Bearer ${await h.token('alice', 'acme', 'sandbox', { orgRole: 'admin' })}` }
    }))
    const lines = (await events.text()).trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.map((e) => (e.type === 'build' ? `build:${e.build.status}` : e.type))).toEqual([
      'build:running', 'log', 'log', 'build:snapshotting', 'build:succeeded', 'end'
    ])
  })

  it('boots new workspaces from the active build; existing ones keep theirs; rollback is instant', async () => {
    const { h, adminCall, envId, build } = await setup()
    const one = await build(0)
    const ws1 = await h.call('POST', '/v1/sandboxes', {
      bearer: await h.token('alice', 'acme', 'sandbox', { orgRole: 'admin' }),
      body: { workspaceId: 'w1', machineSize: 'standard', repo: { url: REPO, ref: 'feature' } }
    })
    expect(ws1.status).toBe(200)
    expect(HostedSandboxReadyResponseSchema.safeParse(ws1.body).success).toBe(true)
    expect(ws1.body.sandbox.environmentBuildId).toBe(one.id)
    const box1 = [...h.vercel.boxes.values()].find((b) => b.params.tags.orcaSandbox === ws1.body.sandbox.id)!
    const snapshotOne = h.vercel.boxes && box1.params.snapshotId
    expect(snapshotOne).not.toBe(GOLDEN)
    const start = h.vercel.commands.filter((c) => c.command === '/opt/orca/bin/orca-sandbox-start').at(-1)!
    expect(start.env.ORCA_ENV_REPO_DIR).toBe('acme/web')
    expect(start.env.ORCA_PRELUDE).toContain('/vercel/sandbox/repos')

    const two = await build(0)
    const ws2 = await adminCall('POST', '/v1/sandboxes', { workspaceId: 'w2', machineSize: 'standard', repo: { url: REPO } })
    expect(ws2.body.sandbox.environmentBuildId).toBe(two.id)
    // Rollback: new workspaces boot #1 again; an explicit build id wins either way.
    expect((await adminCall('POST', `/v1/environments/${envId}/builds/${one.id}/activate`)).body.environment.activeBuildId).toBe(one.id)
    const ws3 = await adminCall('POST', '/v1/sandboxes', { workspaceId: 'w3', machineSize: 'standard', repo: { url: REPO } })
    expect(ws3.body.sandbox.environmentBuildId).toBe(one.id)
    for (const ws of [ws2, ws3]) {
      await adminCall('DELETE', `/v1/sandboxes/${ws.body.sandbox.id}`)
    }
    const ws4 = await adminCall('POST', '/v1/sandboxes', { workspaceId: 'w4', machineSize: 'standard', repo: { url: REPO }, environmentBuildId: two.id })
    expect(ws4.body.sandbox.environmentBuildId).toBe(two.id)
    await adminCall('DELETE', `/v1/sandboxes/${ws4.body.sandbox.id}`)
    const plain = await adminCall('POST', '/v1/sandboxes', { workspaceId: 'w5', machineSize: 'standard', repo: { url: REPO }, useEnvironment: false })
    expect(plain.body.sandbox.environmentBuildId).toBeUndefined()
    // Destroying a workspace never deletes the shared build image it booted from.
    expect((await adminCall('DELETE', `/v1/sandboxes/${ws1.body.sandbox.id}`)).status).toBe(200)
    expect(h.vercel.snapshots.get(snapshotOne)?.status).toBe('created')
  })

  it('rebuilds an environment on the new golden after a swap; old build serves until then, failures keep it', async () => {
    const { h, adminCall, envId, build } = await setup()
    const old = await build(0)
    const activeBuild = () => h.raw.prepare('SELECT b.id, b.base_snapshot_id AS base, b.created_by AS by FROM environments e JOIN environment_builds b ON b.id = e.active_build_id WHERE e.id = ?').get(envId) as { id: string; base: string; by: string }
    expect(activeBuild()).toMatchObject({ id: old.id, base: GOLDEN })
    const refresh = async () => refreshEnvironmentsOnGolden(h.env, (await lifecycleDeps(h.env, h.deps))!, h.deps)
    // Same golden: nothing to do.
    expect(await refresh()).toEqual({ stale: 0, started: 0, skipped: 0 })

    // The golden rotates (the cron activates a new image).
    h.raw.prepare(`INSERT INTO golden_images (id, source, status, snapshot_id, created_at, updated_at, activated_at) VALUES ('g2', 'test', 'active', 'snap_golden_2', ?, ?, ?)`).run(h.now(), h.now(), h.now())
    expect(await refresh()).toEqual({ stale: 1, started: 1, skipped: 0 })
    // The old build keeps serving new workspaces while the rebuild runs.
    expect(activeBuild().id).toBe(old.id)
    const during = await adminCall('POST', '/v1/sandboxes', { workspaceId: 'during', machineSize: 'standard', repo: { url: REPO } })
    expect(during.body.sandbox.environmentBuildId).toBe(old.id)
    // In flight: no second start.
    expect((await refresh()).started).toBe(0)
    const command = [...h.vercel.buildCommands.values()].at(-1)!
    expect(command.sessionId).toBeDefined()
    command.logs = log('::orca-step:: install\nok\n')
    command.exitCode = 0
    h.advance(1000)
    const rebuilt = (await adminCall('GET', `/v1/environments/${envId}/builds`)).body.builds[0]
    await adminCall('GET', `/v1/environments/${envId}/builds/${rebuilt.id}`)
    // Swapped in atomically, built from the new golden, attributed to the system; the old one is kept.
    expect(activeBuild()).toMatchObject({ base: 'snap_golden_2', by: GOLDEN_REFRESH_USER })
    expect(activeBuild().id).not.toBe(old.id)
    const builds = (await adminCall('GET', `/v1/environments/${envId}/builds`)).body.builds
    expect(builds.find((b: { id: string }) => b.id === old.id)).toMatchObject({ status: 'succeeded', activatable: true })
    const after = await adminCall('POST', '/v1/sandboxes', { workspaceId: 'after', machineSize: 'standard', repo: { url: REPO } })
    expect(after.body.sandbox.environmentBuildId).toBe(activeBuild().id)
    // Up to date now.
    expect(await refresh()).toEqual({ stale: 0, started: 0, skipped: 0 })

    // Next rotation, and this time the rebuild fails: the previous build keeps serving, no retry loop.
    const servingBefore = activeBuild().id
    h.raw.prepare(`UPDATE golden_images SET status = 'retired' WHERE id = 'g2'`).run()
    h.raw.prepare(`INSERT INTO golden_images (id, source, status, snapshot_id, created_at, updated_at, activated_at) VALUES ('g3', 'test', 'active', 'snap_golden_3', ?, ?, ?)`).run(h.now() + 1, h.now() + 1, h.now() + 1)
    expect((await refresh()).started).toBe(1)
    const failing = [...h.vercel.buildCommands.values()].at(-1)!
    failing.logs = log('::orca-step:: install\n::orca-error:: The install script exited with status 1.\n')
    failing.exitCode = 20
    h.advance(1000)
    const failedBuild = (await adminCall('GET', `/v1/environments/${envId}/builds`)).body.builds[0]
    expect((await adminCall('GET', `/v1/environments/${envId}/builds/${failedBuild.id}`)).body.build.status).toBe('failed')
    expect(activeBuild().id).toBe(servingBefore)
    expect(await refresh()).toEqual({ stale: 0, started: 0, skipped: 0 })
  })

  it('rate-limits golden refresh starts across environments', async () => {
    const { h, adminCall, build } = await setup()
    await build(0)
    for (const name of ['Two', 'Three', 'Four']) {
      const created = await adminCall('POST', '/v1/environments', { name, repos: [{ url: 'acme/web', defaultBranch: 'main' }], installScript: 'true', envVarNames: [] })
      const id = created.body.environment.id
      await adminCall('POST', `/v1/environments/${id}/builds`)
      const command = [...h.vercel.buildCommands.values()].at(-1)!
      command.logs = log('ok\n')
      command.exitCode = 0
      h.advance(1000)
      const b = (await adminCall('GET', `/v1/environments/${id}/builds`)).body.builds[0]
      await adminCall('GET', `/v1/environments/${id}/builds/${b.id}`)
    }
    h.raw.prepare(`INSERT INTO golden_images (id, source, status, snapshot_id, created_at, updated_at, activated_at) VALUES ('g2', 'test', 'active', 'snap_golden_2', ?, ?, ?)`).run(h.now(), h.now(), h.now())
    const refresh = async () => refreshEnvironmentsOnGolden(h.env, (await lifecycleDeps(h.env, h.deps))!, h.deps)
    expect(await refresh()).toMatchObject({ stale: 4, started: 2 })
    // Two in flight + cap 3: one more this tick at most.
    expect(await refresh()).toMatchObject({ started: 1 })
  })

  it('keeps the newest builds and the active one, pruning older snapshots', async () => {
    const { h, adminCall, envId, build } = await setup()
    const builds = []
    for (let i = 0; i < KEPT_BUILDS + 1; i++) {
      builds.push(await build(0))
    }
    // Roll back to the oldest kept build, then add one more: the active rollback target survives.
    await adminCall('POST', `/v1/environments/${envId}/builds/${builds[1]!.id}/activate`)
    const failedNewer = await build(20)
    expect(failedNewer.status).toBe('failed')
    const kept = async () =>
      ((await adminCall('GET', `/v1/environments/${envId}`)).body.builds as { number: number; activatable: boolean }[])
        .filter((b) => b.activatable).map((b) => b.number).sort((a, b) => a - b)
    expect(await kept()).toEqual([2, 3, 4, 5, 6])
    expect((await adminCall('POST', `/v1/environments/${envId}/builds/${builds[0]!.id}/activate`)).body.reason).toBe('build_not_activatable')
    expect(h.vercel.snapshots.get(builds[0]!.id)).toBeUndefined()
    expect([...h.vercel.snapshots.values()].filter((s) => s.creationMethod === 'manual' && s.status === 'deleted')).toHaveLength(1)
  })

  it('recommends a rebuild when a lockfile changes on the default branch', async () => {
    const github = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/repos/acme/web/compare/' + 'a'.repeat(40) + '...main')
      return Response.json({ ahead_by: 3, commits: [{ sha: 'c'.repeat(40) }], files: [{ filename: 'pnpm-lock.yaml' }, { filename: 'src/x.ts' }] })
    }) as typeof fetch
    const { adminCall, envId, build } = await setup(github)
    expect((await adminCall('GET', `/v1/environments/${envId}/staleness`)).body.staleness.recommendation).toBe('no_build')
    await build(0)
    const stale = (await adminCall('GET', `/v1/environments/${envId}/staleness`)).body.staleness
    expect(stale).toMatchObject({ recommendation: 'deps_changed', configChanged: false })
    expect(stale.repos[0]).toMatchObject({ aheadBy: 3, lockfilesChanged: ['pnpm-lock.yaml'], headCommit: 'c'.repeat(40) })
  })
})
