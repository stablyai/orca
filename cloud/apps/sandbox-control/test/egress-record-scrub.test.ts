// A4 (probe 2: the last session policy survives a stop or timeout on the record and is re-applied on resume):
// a stopped sandbox's record is token-free; the full policy goes back on it right before a resume.
import { describe, expect, it } from 'vitest'
import { lifecycleDeps } from '../src/index'
import { type LifecycleDeps } from '../src/lifecycle'
import { reconcile } from '../src/reconcile'
import { ProviderError } from '../src/sandbox-provider'
import { getSandbox } from '../src/store'
import { createHarness } from './harness'

const KEY = 'sk-ant-api03-REALkeyFORscrubTESTS000000000000000000000000'

async function setup(mode: 'firewall' | 'proxy' = 'firewall') {
  const h = await createHarness({
    SECRETS_KEK: Buffer.alloc(32, 7).toString('base64'),
    EGRESS_PROXY_URL: 'https://sandbox.test/v1/egress/proxy',
    SECRETS_EGRESS_PLACEHOLDERS: 'on',
    EGRESS_SWAP_MODE: mode
  })
  const mia = await h.token('mia', 'acme', 'sandbox', {})
  await h.call('PUT', '/v1/secrets/personal/ANTHROPIC_API_KEY', { body: { value: KEY }, bearer: mia })
  const created = await h.call('POST', '/v1/sandboxes', { bearer: mia, body: { workspaceId: 'ws-1', machineSize: 'standard' } })
  const id: string = created.body.sandbox.id
  const box = () => [...h.vercel.boxes.values()].find((b) => b.params.tags.orcaSandbox === id)!
  const row = async () => (await getSandbox(h.env.SANDBOX_DB, id))!
  return { h, mia, id, box, row }
}

describe('A4: stopped records are token-free', () => {
  it('a sleep scrubs the record (routes kept, no value); a wake puts the full policy back before resuming', async () => {
    const t = await setup()
    expect(JSON.stringify(t.box().policy)).toContain(KEY)
    expect((await t.h.call('POST', `/v1/sandboxes/${t.id}/suspend`, { bearer: t.mia })).status).toBe(200)
    const scrubbed = JSON.stringify(t.box().recordPolicy)
    expect(scrubbed).not.toContain(KEY)
    expect(scrubbed).toContain('api.anthropic.com')
    expect((await t.row())).toMatchObject({ policy_scrub_pending: 0 })
    expect((await t.row()).policy_scrubbed_at).not.toBeNull()
    expect((await t.h.call('POST', `/v1/sandboxes/${t.id}/resume`, { bearer: t.mia })).status).toBe(200)
    expect(JSON.stringify(t.box().recordPolicy)).toContain(KEY)
    expect(JSON.stringify(t.box().policy)).toContain(KEY)
  })

  it('a failed scrub is retried by reconcile', async () => {
    const t = await setup()
    const life = (await lifecycleDeps(t.h.env, t.h.deps))!
    let refuse = true
    const deps: LifecycleDeps = {
      ...life,
      provider: {
        ...life.provider,
        updateRecordNetworkPolicy: async (name, policy) => {
          if (refuse) {
            throw new ProviderError(502, 'bad_gateway')
          }
          return life.provider.updateRecordNetworkPolicy!(name, policy)
        }
      }
    }
    const { suspendSandbox } = await import('../src/lifecycle')
    await suspendSandbox(deps, await t.row())
    expect((await t.row()).policy_scrub_pending).toBe(1)
    refuse = false
    await reconcile(deps)
    expect((await t.row()).policy_scrub_pending).toBe(0)
    expect(JSON.stringify(t.box().recordPolicy)).not.toContain(KEY)
  })

  it('proxy mode: nothing to scrub, no record writes', async () => {
    const t = await setup('proxy')
    expect((await t.h.call('POST', `/v1/sandboxes/${t.id}/suspend`, { bearer: t.mia })).status).toBe(200)
    expect(t.box().recordPolicy).toBeUndefined()
    expect((await t.row()).policy_scrubbed_at).toBeNull()
  })
})
