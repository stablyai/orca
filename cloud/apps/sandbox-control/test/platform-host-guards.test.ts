import { describe, expect, it, vi } from 'vitest'
import { reconcile } from '../src/reconcile'
import { egressAllowlistSetting } from '../src/network-policy'
import { GOLDEN, createHarness } from './harness'

const create = { workspaceId: 'ws-1', machineSize: 'standard' }
const MALFORMED = '*.orca.dev, not a host'

/** A limited-mode deployment whose ORCA_PLATFORM_HOST_SUFFIXES is fine at first and then breaks. */
async function limited() {
  const h = await createHarness({ SANDBOX_EGRESS_PRESET: 'limited' })
  const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
  expect(body.sandbox.status).toBe('running')
  h.env.ORCA_PLATFORM_HOST_SUFFIXES = MALFORMED
  return { h, id: body.sandbox.id as string }
}

describe('a malformed ORCA_PLATFORM_HOST_SUFFIXES (PLATFORM-SUFFIX-GUARDS)', () => {
  it('fails the health route a post-deploy smoke hits, with the code only; the log names the bad entry', async () => {
    const h = await createHarness()
    expect(await h.call('GET', '/v1/health')).toMatchObject({ status: 200, body: { ok: true } })
    h.env.ORCA_PLATFORM_HOST_SUFFIXES = MALFORMED
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(await h.call('GET', '/v1/health')).toEqual({ status: 503, body: { error: 'platform_hosts_misconfigured' } })
      const line = JSON.parse(String(logged.mock.calls.at(-1)?.[0]))
      expect(line).toMatchObject({ event: 'config_error', variable: 'ORCA_PLATFORM_HOST_SUFFIXES', invalid: ['not a host'] })
    } finally {
      logged.mockRestore()
    }
  })

  it('refuses a limited-mode create with 503 before anything is provisioned', async () => {
    const { h } = await limited()
    const boxes = h.vercel.boxes.size
    const refused = await h.call('POST', '/v1/sandboxes', { body: { ...create, workspaceId: 'ws-2' } })
    expect(refused.status).toBe(503)
    expect(refused.body.error).toBe('platform_hosts_misconfigured')
    expect(h.vercel.boxes.size).toBe(boxes)
  })

  it('keeps reads, sleep and delete working, and refuses the wake', async () => {
    const { h, id } = await limited()
    expect((await h.call('GET', '/v1/sandboxes')).body.sandboxes).toHaveLength(1)
    expect((await h.call('POST', `/v1/sandboxes/${id}/suspend`)).status).toBe(200)
    const resumed = await h.call('POST', `/v1/sandboxes/${id}/resume`)
    expect(resumed.status).toBe(503)
    expect(resumed.body.error).toBe('platform_hosts_misconfigured')
    const destroyed = await h.call('DELETE', `/v1/sandboxes/${id}`)
    expect(destroyed.status).toBe(200)
    expect(destroyed.body.sandbox.status).toBe('destroyed')
  })

  it('leaves open-mode creates alone: they compile no allowlist', async () => {
    const h = await createHarness()
    h.env.ORCA_PLATFORM_HOST_SUFFIXES = MALFORMED
    expect((await h.call('POST', '/v1/sandboxes', { body: create })).body.sandbox.status).toBe('running')
  })

  it('keeps the reconcile cron running for a limited-mode sandbox', async () => {
    const { h } = await limited()
    const summary = await reconcile({
      db: h.env.SANDBOX_DB,
      provider: h.vercel,
      entitlements: h.deps.entitlements!,
      now: h.now,
      config: {
        environment: 'test',
        goldenSnapshotId: GOLDEN,
        defaultRegion: 'iad1',
        egressPreset: 'limited',
        egressAllowlistError: egressAllowlistSetting(MALFORMED).error
      }
    })
    expect(summary.settled).toBe(1)
  })
})
