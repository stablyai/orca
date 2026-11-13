// CREATE-BUILD-SNAPSHOT-404: on dev a VM create from an environment build's snapshot answered 404
// shortly after the build (the same snapshot booted seconds before and after). One retry, after a
// short wait, for a build under 15 min old; never for goldens, older builds or other errors.
// CREATE-FAIL-LABELS: a create that broke in orcad's start with an error of no known kind is named
// by that step (orcad_start_timeout past the 120 s budget), not the generic create_failed.
import { describe, expect, it } from 'vitest'
import { createFailureReason, phaseTimer } from '../src/lifecycle'
import { ProviderError } from '../src/sandbox-provider'
import { START_TIMEOUT_MS, VmCommandError } from '../src/sandbox-vm-commands'
import { GOLDEN, createHarness } from './harness'

const REPO = 'https://github.com/acme/web.git'
const RESULT = JSON.stringify({
  durationSec: 3,
  repos: [{ url: REPO, dir: 'acme/web', branch: 'main', commit: 'a'.repeat(40), lockfiles: {} }],
  diskUsedBytes: 1,
  diskTotalBytes: 2
})

async function setup() {
  const sleeps: number[] = []
  const h = await createHarness({}, { sleep: async (ms) => void sleeps.push(ms) })
  h.vercel.buildResult = RESULT
  // A fresh token per call: some tests move the clock past a token's 15 min age.
  const call = async (method: string, path: string, body?: unknown) =>
    h.call(method, path, { bearer: await h.token('alice', 'acme', 'sandbox', { orgRole: 'admin' }), body })
  const env = await call('POST', '/v1/environments', { name: 'Default', repos: [{ url: 'acme/web', defaultBranch: 'main' }], installScript: 'true' })
  const envId: string = env.body.environment.id
  const started = await call('POST', `/v1/environments/${envId}/builds`)
  const command = [...h.vercel.buildCommands.values()].at(-1)!
  command.logs = `${JSON.stringify({ data: '::orca-step:: install\nok\n', stream: 'stdout' })}\n`
  command.exitCode = 0
  h.advance(1000)
  const build = (await call('GET', `/v1/environments/${envId}/builds/${started.body.build.id}`)).body.build
  expect(build.status).toBe('succeeded')
  // The provider answers `failures` (in order) to the next VM creates, then creates normally.
  const failures: number[] = []
  const snapshotsTried: string[] = []
  const createVm = h.vercel.createSandbox.bind(h.vercel)
  h.vercel.createSandbox = async (params) => {
    if (params.name.includes('smoke') || params.name.includes('envbuild')) {
      return createVm(params)
    }
    snapshotsTried.push(params.snapshotId)
    const status = failures.shift()
    if (status) {
      throw new ProviderError(status, 'provider_failed')
    }
    return createVm(params)
  }
  const create = (workspaceId: string, repo = true) =>
    call('POST', '/v1/sandboxes', { workspaceId, machineSize: 'standard', ...(repo ? { repo: { url: REPO } } : {}) })
  const lastError = (workspaceId: string) =>
    (h.raw.prepare('SELECT last_error FROM sandboxes WHERE workspace_id = ? ORDER BY rowid DESC').get(workspaceId) as { last_error: string | null }).last_error
  return { h, build, failures, snapshotsTried, sleeps, create, lastError }
}

describe('CREATE-BUILD-SNAPSHOT-404', () => {
  it('a just-built snapshot that answers 404 is retried once after ~5 s, and the create succeeds', async () => {
    const t = await setup()
    t.failures.push(404)
    const created = await t.create('ws-fresh')
    expect(created.status).toBe(200)
    expect(created.body.sandbox.environmentBuildId).toBe(t.build.id)
    expect(t.sleeps).toEqual([5_000])
    expect(t.snapshotsTried).toHaveLength(2)
    expect(t.snapshotsTried[0]).toBe(t.snapshotsTried[1])
    expect(t.snapshotsTried[0]).not.toBe(GOLDEN)
  })

  it('only once: a second 404 fails the create as before (provider_404)', async () => {
    const t = await setup()
    t.failures.push(404, 404)
    expect((await t.create('ws-twice')).status).not.toBe(200)
    expect(t.sleeps).toEqual([5_000])
    expect(t.snapshotsTried).toHaveLength(2)
    expect(t.lastError('ws-twice')).toBe('provider_404')
  })

  it('no retry when the create was deleted meanwhile (a cancel): its 404 is the delete, not the snapshot', async () => {
    const t = await setup()
    t.h.vercel.createSandbox = async (params) => {
      // The owner's delete lands while the VM is being made; the provider then answers 404.
      t.h.raw.prepare(`UPDATE sandboxes SET status = 'destroyed' WHERE workspace_id = 'ws-cancelled'`).run()
      t.snapshotsTried.push(params.snapshotId)
      throw new ProviderError(404, 'not_found')
    }
    expect((await t.create('ws-cancelled')).status).not.toBe(200)
    expect(t.sleeps).toEqual([])
    expect(t.snapshotsTried).toHaveLength(1)
  })

  it('no retry for a build older than 15 min', async () => {
    const t = await setup()
    t.h.advance(16 * 60_000)
    t.failures.push(404)
    expect((await t.create('ws-old')).status).not.toBe(200)
    expect(t.sleeps).toEqual([])
    expect(t.snapshotsTried).toHaveLength(1)
  })

  it('no retry for other errors (403) on a fresh build', async () => {
    const t = await setup()
    t.failures.push(403)
    expect((await t.create('ws-403')).status).not.toBe(200)
    expect(t.sleeps).toEqual([])
    expect(t.lastError('ws-403')).toBe('provider_403')
  })

  it('no retry for the golden image', async () => {
    const t = await setup()
    t.failures.push(404)
    expect((await t.create('ws-golden', false)).status).not.toBe(200)
    expect(t.snapshotsTried[0]).toBe(GOLDEN)
    expect(t.sleeps).toEqual([])
    expect(t.snapshotsTried).toHaveLength(1)
  })
})

describe('CREATE-FAIL-LABELS', () => {
  const failIn = async (phase: string, ms: number) => {
    let clock = 0
    const timer = phaseTimer(() => clock)
    await timer
      .time(phase, async () => {
        clock += ms
        throw new TypeError('Network connection lost.')
      })
      .catch(() => undefined)
    return timer
  }

  it("names an unknown error in orcad's start by the step: a timeout at the 120 s budget, an error before it", async () => {
    expect(createFailureReason(new TypeError('x'), await failIn('orcad', START_TIMEOUT_MS + 7_000))).toBe('orcad_start_timeout')
    expect(createFailureReason(new TypeError('x'), await failIn('orcad', 2_000))).toBe('orcad_start_error')
  })

  it('keeps the known kinds and the generic label elsewhere', async () => {
    const orcad = await failIn('orcad', START_TIMEOUT_MS)
    expect(createFailureReason(new VmCommandError('orcad_start_failed'), orcad)).toBe('orcad_start_failed')
    expect(createFailureReason(new ProviderError(404, 'gone'), orcad)).toBe('provider_404')
    expect(createFailureReason(new TypeError('x'), await failIn('vm', 1_000))).toBe('create_failed')
    expect(createFailureReason(new TypeError('x'))).toBe('create_failed')
  })

  it('the timer records only the first phase that threw, and keeps timings numeric (Server-Timing)', async () => {
    const timer = await failIn('orcad', 5)
    await timer.time('later', async () => Promise.reject(new Error('x'))).catch(() => undefined)
    expect(timer.failed).toEqual({ phase: 'orcad', ms: 5 })
    expect(Object.values(timer.timings).every((v) => typeof v === 'number')).toBe(true)
  })
})
