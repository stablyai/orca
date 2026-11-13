// Automatic environments: the first create of a repo builds it in the background; later creates boot
// with the repo checked out and only fetch what changed.
import { describe, expect, it } from 'vitest'
import { HostedSandboxReadyResponseSchema } from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { AUTO_ENVIRONMENT_UNUSED_MS, AUTO_RETRY_AFTER_MS, expireAutoEnvironments } from '../src/auto-environments'
import { refreshStaleEnvironments } from '../src/environment-golden-refresh'
import { START_COMMAND } from '../src/sandbox-vm-commands'
import { GOLDEN, createHarness } from './harness'

const REPO = 'https://github.com/acme/web.git'
const RESULT = JSON.stringify({
  durationSec: 3,
  repos: [{ url: REPO, dir: 'acme/web', branch: 'main', commit: 'a'.repeat(40), lockfiles: {} }],
  diskUsedBytes: 3_000_000_000,
  diskTotalBytes: 34_000_000_000
})
const FEATURES = { 'x-orca-sandbox-features': 'clone-progress,repo-update' }

async function setup() {
  const pending: Promise<unknown>[] = []
  const h = await createHarness({ AUTO_ENVIRONMENTS: 'on' }, { waitUntil: (work: Promise<unknown>) => void pending.push(work) })
  h.vercel.buildResult = RESULT
  const settle = async () => {
    while (pending.length > 0) {
      await Promise.all(pending.splice(0))
    }
  }
  const environments = () =>
    h.raw.prepare('SELECT id, account_id, kind, name, active_build_id, deleted_at, last_used_at FROM environments').all() as {
      id: string
      account_id: string
      kind: string
      name: string
      active_build_id: string | null
      deleted_at: number | null
      last_used_at: number | null
    }[]
  /** Lets the auto build's VM command succeed and finalizes it. */
  async function finishBuild(as = 'alice', output = '::orca-step:: clone\n') {
    const env = environments().find((row) => row.deleted_at === null && !row.active_build_id)!
    const build = h.raw.prepare('SELECT id FROM environment_builds WHERE environment_id = ? ORDER BY number DESC').get(env.id) as { id: string }
    const command = [...h.vercel.buildCommands.values()].at(-1)!
    command.logs = `${JSON.stringify({ data: output, stream: 'stdout' })}\n`
    command.exitCode = 0
    h.advance(1000)
    const done = await h.call('GET', `/v1/environments/${env.id}/builds/${build.id}`, { as })
    expect(done.body.build.status).toBe('succeeded')
    return { env, buildId: build.id, build: done.body.build }
  }
  return { h, settle, environments, finishBuild }
}

describe('automatic environments', () => {
  it('the first create of a repo builds it (blobless); the next boots with it checked out and fetches only changes', async () => {
    const { h, settle, environments, finishBuild } = await setup()
    const first = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'w1', machineSize: 'standard', repo: { url: REPO } }, headers: FEATURES })
    expect(first.body.clone).toEqual({ state: 'running' })
    await settle()
    expect(environments()).toMatchObject([{ kind: 'auto', name: 'acme/web', active_build_id: null }])
    const command = [...h.vercel.buildCommands.values()].at(-1)!
    expect(command.env.ORCA_CLONE_FILTER).toBe('blob:none')
    // PARITY-AUTO-ENV-DEPS: its lockfile's dependencies too, so creates start warm.
    expect(command.env.ORCA_AUTO_INSTALL).toBe('1')
    const { buildId } = await finishBuild()

    h.vercel.commands.length = 0
    const second = await h.call('POST', '/v1/sandboxes', {
      body: { workspaceId: 'w2', machineSize: 'standard', repo: { url: REPO, ref: 'feature' } },
      headers: FEATURES
    })
    expect(second.status).toBe(200)
    expect(second.body.sandbox.environmentBuildId).toBe(buildId)
    expect(second.body.clone).toEqual({ state: 'running', mode: 'update' })
    expect(HostedSandboxReadyResponseSchema.safeParse({ ...second.body, clone: { state: 'running' } }).success).toBe(true)
    const start = h.vercel.commands.find((c) => c.command === START_COMMAND)!
    expect(start.env).toMatchObject({ ORCA_ENV_REPO_DIR: 'acme/web', ORCA_CLONE_BACKGROUND: '1' })
    const box = [...h.vercel.boxes.values()].find((b) => b.params.tags.orcaSandbox === second.body.sandbox.id)!
    expect(box.params.snapshotId).not.toBe(GOLDEN)
    await settle()
    expect(environments()[0]!.last_used_at).toBe(h.now())
    // A desktop without `repo-update` sees the plain clone shape it knows.
    const older = await h.call('POST', '/v1/sandboxes', {
      body: { workspaceId: 'w3', machineSize: 'standard', repo: { url: REPO } },
      headers: { 'x-orca-sandbox-features': 'clone-progress' }
    })
    expect(older.body.clone).toEqual({ state: 'running' })
  })

  it('is per account, never shadows an admin environment, and makes one environment per repo', async () => {
    const { h, settle, environments } = await setup()
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'a1', machineSize: 'standard', repo: { url: REPO } } })
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'a2', machineSize: 'standard', repo: { url: 'acme/web' } } })
    await settle()
    const bob = await h.call('POST', '/v1/sandboxes', { as: 'bob', body: { workspaceId: 'b1', machineSize: 'standard', repo: { url: REPO } } })
    await settle()
    expect(bob.body.sandbox.environmentBuildId).toBeUndefined()
    const rows = environments()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.account_id)).size).toBe(2)

    // An org whose admin lists the repo: no automatic one next to it.
    const admin = await h.token('carol', 'acme', 'sandbox', { orgRole: 'admin' })
    expect(
      (await h.call('POST', '/v1/environments', { bearer: admin, body: { name: 'Web', repos: [{ url: 'acme/web' }], installScript: '' } })).status
    ).toBe(200)
    await h.call('POST', '/v1/sandboxes', { bearer: admin, body: { workspaceId: 'c1', machineSize: 'standard', repo: { url: REPO } } })
    await settle()
    expect(environments().filter((row) => row.kind === 'auto')).toHaveLength(2)
  })

  it('the build says what its lockfile install did (AUTO-ENV-DEPS-LABEL)', async () => {
    const { h, settle, finishBuild } = await setup()
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'w1', machineSize: 'standard', repo: { url: REPO } }, headers: FEATURES })
    await settle()
    const { build } = await finishBuild(
      'alice',
      '::orca-step:: install\nInstalling dependencies automatically: corepack pnpm install --frozen-lockfile\nInstalled dependencies in 42s.\n'
    )
    expect(build.autoInstall).toEqual({ manager: 'pnpm', outcome: 'installed' })
  })

  it('every build of an automatic environment installs from the lockfile: manual Rebuild and golden refresh too (AUTO-ENV-DEPS-NOT-RUNNING)', async () => {
    const { h, settle, finishBuild } = await setup()
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'w1', machineSize: 'standard', repo: { url: REPO } }, headers: FEATURES })
    await settle()
    const { env, buildId } = await finishBuild()
    // An active build from before #660: its stored config has no autoInstall (dev's Eval Team case).
    h.raw.prepare('UPDATE environment_builds SET config = ? WHERE id = ?').run(
      JSON.stringify({ revision: 1, repos: [{ url: REPO, defaultBranch: null }], installScript: '', envVarNames: [], machineSize: 'standard' }),
      buildId
    )
    const lastCommand = () => [...h.vercel.buildCommands.values()].at(-1)!

    // Golden refresh: a new golden makes the active build stale; the refresh reuses its stored config.
    h.raw.prepare('UPDATE environment_builds SET base_snapshot_id = ? WHERE id = ?').run('snap_old_golden', buildId)
    const deps = {
      db: h.env.SANDBOX_DB,
      provider: h.vercel,
      entitlements: { checkStart: async () => h.billing.decision, reportUsage: async () => h.billing.usageAnswer, listSuspensions: async () => [] },
      now: h.now,
      config: { environment: 'test', goldenSnapshotId: GOLDEN, region: 'iad1' }
    }
    expect((await refreshStaleEnvironments(deps as never)).started).toBe(1)
    expect(lastCommand().env).toMatchObject({ ORCA_AUTO_INSTALL: '1', ORCA_CLONE_FILTER: 'blob:none' })
    // Let the refresh build finish, so a manual Rebuild may start.
    const refresh = h.raw.prepare('SELECT id FROM environment_builds WHERE environment_id = ? ORDER BY number DESC').get(env.id) as { id: string }
    lastCommand().logs = `${JSON.stringify({ data: '::orca-step:: clone\n', stream: 'stdout' })}\n`
    lastCommand().exitCode = 0
    h.advance(1000)
    expect((await h.call('GET', `/v1/environments/${env.id}/builds/${refresh.id}`)).body.build.status).toBe('succeeded')

    // Manual Rebuild by the account's own admin: no config passed, the environment's own.
    const rebuilt = await h.call('POST', `/v1/environments/${env.id}/builds`)
    expect(rebuilt.status).toBe(200)
    expect(lastCommand().env).toMatchObject({ ORCA_AUTO_INSTALL: '1', ORCA_CLONE_FILTER: 'blob:none' })
  })

  it('a failed automatic build retried by a later create installs from the lockfile too', async () => {
    const { h, settle } = await setup()
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'w1', machineSize: 'standard', repo: { url: REPO } }, headers: FEATURES })
    await settle()
    const first = [...h.vercel.buildCommands.values()].at(-1)!
    first.logs = `${JSON.stringify({ data: '::orca-step:: clone\n', stream: 'stdout' })}\n`
    first.exitCode = 10
    h.advance(1000)
    const env = h.raw.prepare("SELECT id FROM environments WHERE kind = 'auto'").get() as { id: string }
    const failed = h.raw.prepare('SELECT id FROM environment_builds WHERE environment_id = ?').get(env.id) as { id: string }
    expect((await h.call('GET', `/v1/environments/${env.id}/builds/${failed.id}`)).body.build.status).toBe('failed')
    h.advance(AUTO_RETRY_AFTER_MS + 60_000)
    const count = h.vercel.buildCommands.size
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'w2', machineSize: 'standard', repo: { url: REPO } }, headers: FEATURES })
    await settle()
    expect(h.vercel.buildCommands.size).toBe(count + 1)
    expect([...h.vercel.buildCommands.values()].at(-1)!.env).toMatchObject({ ORCA_AUTO_INSTALL: '1', ORCA_CLONE_FILTER: 'blob:none' })
  })

  it("an admin's environment never installs automatically, with or without its own script", async () => {
    const { h } = await setup()
    const admin = await h.token('carol', 'acme', 'sandbox', { orgRole: 'admin' })
    const created = await h.call('POST', '/v1/environments', {
      bearer: admin,
      body: { name: 'Web', repos: [{ url: 'acme/web' }], installScript: '' }
    })
    expect(created.status).toBe(200)
    expect((await h.call('POST', `/v1/environments/${created.body.environment.id}/builds`, { bearer: admin })).status).toBe(200)
    const command = [...h.vercel.buildCommands.values()].at(-1)!
    expect(command.env.ORCA_AUTO_INSTALL).toBeUndefined()
  })

  it('boot-plan says clone before the environment exists and update after (PC-4)', async () => {
    const { h, settle, finishBuild } = await setup()
    const plan = async () => (await h.call('GET', `/v1/sandboxes/boot-plan?repo=${encodeURIComponent(REPO)}`)).body
    expect(await plan()).toEqual({ repo: 'clone' })
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'w1', machineSize: 'standard', repo: { url: REPO } } })
    await settle()
    expect(await plan()).toEqual({ repo: 'clone' })
    await finishBuild()
    expect(await plan()).toEqual({ repo: 'update' })
    // Another account's environment is never theirs to boot.
    expect((await h.call('GET', `/v1/sandboxes/boot-plan?repo=${encodeURIComponent(REPO)}`, { as: 'bob' })).body).toEqual({
      repo: 'clone'
    })
  })

  it('goes after 14 days unused, with its snapshot', async () => {
    const { h, settle, environments, finishBuild } = await setup()
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'w1', machineSize: 'standard', repo: { url: REPO } } })
    await settle()
    const { buildId } = await finishBuild()
    const snapshotId = (h.raw.prepare('SELECT snapshot_id FROM environment_builds WHERE id = ?').get(buildId) as { snapshot_id: string }).snapshot_id
    h.advance(AUTO_ENVIRONMENT_UNUSED_MS + 60_000)
    const deps = {
      db: h.env.SANDBOX_DB,
      provider: h.vercel,
      entitlements: { checkStart: async () => h.billing.decision, reportUsage: async () => h.billing.usageAnswer, listSuspensions: async () => [] },
      now: h.now,
      config: { environment: 'test', goldenSnapshotId: GOLDEN, region: 'iad1' }
    }
    expect(await expireAutoEnvironments(deps as never)).toBe(1)
    expect(environments()[0]!.deleted_at).not.toBeNull()
    expect(h.vercel.snapshots.get(snapshotId)?.status).not.toBe('created')
  })
})
