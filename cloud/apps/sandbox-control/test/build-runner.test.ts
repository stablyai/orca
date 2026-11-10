import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EnvironmentBuildRunner, RUNNER_RETRY_MS, type BuildTickerApi, type RunnerBuild } from '../src/build-runner'
import { BuildTicker, runBuildTick } from '../src/index'
import type { Env } from '../src/env'
import { createHarness } from './harness'

const RESULT = JSON.stringify({
  durationSec: 3,
  repos: [{ url: 'https://github.com/acme/web.git', dir: 'acme/web', branch: 'main', commit: 'a'.repeat(40), lockfiles: {} }],
  diskUsedBytes: 3_000_000_000,
  diskTotalBytes: 34_000_000_000
})

/** Durable Object storage as the runner uses it: one key and one alarm. */
function fakeState() {
  const data = new Map<string, unknown>()
  let alarm: number | null = null
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => void data.set(key, value),
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => void (alarm = at),
    deleteAll: async () => {
      data.clear()
      alarm = null
    }
  }
  return { state: { storage } as unknown as DurableObjectState, data, alarm: () => alarm }
}

function runnerFor(control: BuildTickerApi) {
  const fake = fakeState()
  const runner = new EnvironmentBuildRunner(fake.state, { CONTROL: control })
  const start = (build: RunnerBuild) => runner.fetch(new Request('https://runner/start', { method: 'POST', body: JSON.stringify(build) }))
  return { ...fake, runner, start }
}

/** Reads a wrangler .jsonc (full-line comments only, as ours are written). */
function wranglerConfig(file: string): any {
  const text = readFileSync(`${import.meta.dirname}/../${file}`, 'utf8')
  return JSON.parse(
    text
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
  )
}

describe('environment build runner Worker', () => {
  it('finishes a build through runner alarms that step it in the control plane (nobody watching)', async () => {
    let runner: ReturnType<typeof runnerFor> | null = null
    const h = await createHarness({}, { scheduleBuild: async (build) => void (await runner!.start(build)) })
    // The runner's CONTROL binding: BuildTicker.tickBuild, i.e. runBuildTick with the control plane's deps.
    const ticks: RunnerBuild[] = []
    runner = runnerFor({
      tickBuild: async (build) => {
        ticks.push(build)
        return runBuildTick(h.env, build, h.deps)
      }
    })
    h.vercel.buildResult = RESULT
    const admin = await h.token('alice', 'acme', 'sandbox', { orgRole: 'admin' })
    const env = await h.call('POST', '/v1/environments', { bearer: admin, body: { name: 'Default', repos: [{ url: 'acme/web' }], installScript: 'echo hi' } })
    const envId = env.body.environment.id
    const started = await h.call('POST', `/v1/environments/${envId}/builds`, { bearer: admin })
    expect(started.body.build.status).toBe('running')
    const build = { id: started.body.build.id, environmentId: envId }
    // Armed at start; the first alarm comes 2 s later.
    expect(runner.data.get('build')).toEqual(build)
    expect(runner.alarm()).not.toBeNull()
    // While the VM command runs, each alarm re-arms on a short cadence.
    await runner.runner.alarm()
    expect(ticks).toEqual([build])
    expect(runner.alarm()).not.toBeNull()
    const command = [...h.vercel.buildCommands.values()].at(-1)!
    command.logs = `${JSON.stringify({ data: '::orca-step:: install\nhi\n', stream: 'stdout' })}\n`
    command.exitCode = 0
    h.advance(3_000)
    // The next alarm finalizes (snapshot, smoke boot, activation, billing) and the runner clears itself.
    await runner.runner.alarm()
    expect(runner.alarm()).toBeNull()
    expect(runner.data.size).toBe(0)
    const row = h.raw.prepare('SELECT status, usage_reported_at FROM environment_builds WHERE id = ?').get(build.id) as {
      status: string
      usage_reported_at: number | null
    }
    expect(row.status).toBe('succeeded')
    expect(row.usage_reported_at).not.toBeNull()
    const environment = (await h.call('GET', `/v1/environments/${envId}`, { bearer: admin })).body.environment
    expect(environment.activeBuildId).toBe(build.id)
  })

  it('retries after a failed step (control plane unreachable) and keeps its build', async () => {
    const r = runnerFor({
      tickBuild: async () => {
        throw new Error('service binding down')
      }
    })
    await r.start({ id: 'b1', environmentId: 'e1' })
    const before = Date.now()
    await r.runner.alarm()
    expect(r.alarm()).toBeGreaterThanOrEqual(before + RUNNER_RETRY_MS)
    expect(r.data.get('build')).toEqual({ id: 'b1', environmentId: 'e1' })
  })

  it('stops when the control plane answers null, and refuses a start without a build', async () => {
    const r = runnerFor({ tickBuild: async () => null })
    expect((await r.runner.fetch(new Request('https://runner/start', { method: 'POST', body: '{}' }))).status).toBe(400)
    await r.start({ id: 'b1', environmentId: 'e1' })
    await r.runner.alarm()
    expect(r.alarm()).toBeNull()
    expect(r.data.size).toBe(0)
  })

  it('runBuildTick answers null for an unknown build and when the control plane is unconfigured', async () => {
    const h = await createHarness()
    expect(await runBuildTick(h.env, { id: 'nope', environmentId: 'nope' }, h.deps)).toBeNull()
    const bare: Env = { ...h.env, VERCEL_TOKEN: undefined, VERCEL_TEAM_ID: undefined }
    expect(await runBuildTick(bare, { id: 'nope', environmentId: 'nope' })).toBeNull()
    // The RPC entrypoint the runner calls is that same step.
    expect(await new BuildTicker({} as ExecutionContext, bare).tickBuild({ id: 'nope', environmentId: 'nope' })).toBeNull()
  })

  it('dev configs: the control plane implements no Durable Object (preview URLs) and binds the runner Worker', () => {
    const control = wranglerConfig('wrangler.dev.jsonc')
    const runner = wranglerConfig('wrangler.build-runner.dev.jsonc')
    expect(control.durable_objects.bindings).toEqual([
      { name: 'ENV_BUILD_RUNNER', class_name: 'EnvironmentBuildRunner', script_name: runner.name }
    ])
    // Every class the control plane ever created is deleted again by a later migration.
    const created = control.migrations.flatMap((m: any) => m.new_sqlite_classes ?? [])
    const deleted = control.migrations.flatMap((m: any) => m.deleted_classes ?? [])
    expect(created.every((name: string) => deleted.includes(name))).toBe(true)
    expect(control.preview_urls).toBe(true)
    expect(runner.main).toBe('src/build-runner.ts')
    expect(runner.migrations.flatMap((m: any) => m.new_sqlite_classes ?? [])).toEqual(['EnvironmentBuildRunner'])
    expect(runner.services).toEqual([{ binding: 'CONTROL', service: control.name, entrypoint: 'BuildTicker' }])
    // The runner holds no data and no secrets: every step runs in the control plane.
    expect(runner.d1_databases).toBeUndefined()
    expect(runner.vars).toBeUndefined()
  })

  it('local configs pair the same way (pnpm dev runs both)', () => {
    const control = wranglerConfig('wrangler.jsonc')
    const runner = wranglerConfig('wrangler.build-runner.jsonc')
    expect(control.durable_objects.bindings[0].script_name).toBe(runner.name)
    expect(control.migrations).toBeUndefined()
    expect(runner.services[0]).toEqual({ binding: 'CONTROL', service: control.name, entrypoint: 'BuildTicker' })
  })
})
