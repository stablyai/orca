// EGRESS-COMPILE: every live policy write goes through applySandboxPolicy (design §2, §7.1).
import { describe, expect, it, vi } from 'vitest'
import { lifecycleDeps } from '../src/index'
import { applySandboxPolicy, type LifecycleDeps } from '../src/lifecycle'
import { ProviderError } from '../src/sandbox-provider'
import { getSandbox } from '../src/store'
import { createHarness } from './harness'

async function setup() {
  const h = await createHarness({ EGRESS_PROXY_URL: 'https://sandbox.test/v1/egress/proxy' }, {
    github: { tokenForRepo: async () => ({ token: 'ghs_SECRET_TOKEN', expiresAt: h.now() + 3_600_000 }), installationForRepo: async () => null } as never
  })
  const alice = await h.token('alice', 'acme', 'sandbox', { org_role: 'member' })
  const created = await h.call('POST', '/v1/sandboxes', { bearer: alice, body: { workspaceId: 'ws-1', machineSize: 'standard', repo: { url: 'https://github.com/acme/app' } } })
  const id: string = created.body.sandbox.id
  const life = (await lifecycleDeps(h.env, h.deps))!
  const row = async () => (await getSandbox(h.env.SANDBOX_DB, id))!
  const box = () => [...h.vercel.boxes.values()].find((b) => b.params.tags?.orcaSandbox === id)!
  const failing = (times: number): LifecycleDeps => {
    let left = times
    return {
      ...life,
      provider: {
        ...life.provider,
        updateNetworkPolicy: async (sessionId, policy) => {
          if (left-- > 0) {
            throw new ProviderError(502, 'bad_gateway')
          }
          return life.provider.updateNetworkPolicy(sessionId, policy)
        }
      }
    }
  }
  return { h, id, life, row, box, failing }
}

describe('applySandboxPolicy (EGRESS-COMPILE)', () => {
  it('compiles the whole policy (the git route too), stamps a generation and returns the token expiry', async () => {
    const t = await setup()
    t.box().policy = { allow: {} }
    const applied = await applySandboxPolicy(t.life, await t.row(), 'refresh')
    expect(applied.applied).toBe(true)
    expect(applied.gitExpiresAt).not.toBeNull()
    expect(t.box().policy.allow['github.com']?.length).toBeGreaterThan(0)
    expect((await t.row()).policy_generation).toBe(applied.generation)
  })

  it('an older write never lands over a newer one (another isolate already wrote a later generation)', async () => {
    const t = await setup()
    await t.h.env.SANDBOX_DB.prepare('UPDATE sandboxes SET policy_generation = ? WHERE id = ?').bind(Number.MAX_SAFE_INTEGER, t.id).run()
    t.box().policy = { allow: {} }
    const applied = await applySandboxPolicy(t.life, await t.row(), 'refresh')
    expect(applied.applied).toBe(false)
    expect(t.box().policy).toEqual({ allow: {} })
  })

  it('retries a failed write, then succeeds', async () => {
    const t = await setup()
    expect((await applySandboxPolicy(t.failing(2), await t.row(), 'refresh')).applied).toBe(true)
  })

  it('a widening write that keeps failing marks the row stale for reconcile; the session keeps running', async () => {
    const t = await setup()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(applySandboxPolicy(t.failing(9), await t.row(), 'refresh')).rejects.toBeInstanceOf(ProviderError)
    const row = await t.row()
    expect(row.policy_stale_at).not.toBeNull()
    expect(row.status).toBe('running')
    // The failure is logged by its code only: never an error text that could echo a header value.
    const logged = errors.mock.calls.map(([line]) => String(line)).join('\n')
    expect(logged).toContain('"code":"bad_gateway"')
    expect(logged).not.toContain('ghs_SECRET_TOKEN')
    errors.mockRestore()
  })

  it('a narrowing write that keeps failing stops the sandbox (fail closed)', async () => {
    const t = await setup()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(applySandboxPolicy(t.failing(9), await t.row(), 'account_revoked')).rejects.toBeInstanceOf(ProviderError)
    expect((await t.row()).status).not.toBe('running')
    vi.restoreAllMocks()
  })

  it('writes one at a time per sandbox, in call order', async () => {
    const t = await setup()
    const order: string[] = []
    const deps: LifecycleDeps = {
      ...t.life,
      provider: {
        ...t.life.provider,
        updateNetworkPolicy: async (sessionId, policy) => {
          order.push('start')
          await new Promise((r) => setTimeout(r, 10))
          order.push('end')
          return t.life.provider.updateNetworkPolicy(sessionId, policy)
        }
      }
    }
    const row = await t.row()
    await Promise.all([applySandboxPolicy(deps, row, 'refresh'), applySandboxPolicy(deps, row, 'refresh')])
    expect(order).toEqual(['start', 'end', 'start', 'end'])
  })
})

describe('egressSwapModeFor', () => {
  it('a sandbox’s own mode wins; else the environment’s; else proxy', async () => {
    const { egressSwapModeFor } = await import('../src/lifecycle')
    const deps = (egressSwapMode?: 'proxy' | 'firewall') => ({ config: { ...(egressSwapMode ? { egressSwapMode } : {}) } }) as never
    expect(egressSwapModeFor(deps(), { egress_swap_mode: null })).toBe('proxy')
    expect(egressSwapModeFor(deps('firewall'), { egress_swap_mode: null })).toBe('firewall')
    expect(egressSwapModeFor(deps('firewall'), { egress_swap_mode: 'proxy' })).toBe('proxy')
    expect(egressSwapModeFor(deps(), { egress_swap_mode: 'bogus' })).toBe('proxy')
  })
})

describe('review F2: a stale compile can never be the last write to land', () => {
  it('a newer writer claimed while ours was in flight: ours writes again from current state', async () => {
    const t = await setup()
    const writes: string[] = []
    let first = true
    const deps: LifecycleDeps = {
      ...t.life,
      provider: {
        ...t.life.provider,
        updateNetworkPolicy: async (sessionId, policy) => {
          writes.push(first ? 'stale' : 'fresh')
          if (first) {
            first = false
            // Another isolate claims a later generation (after, say, a share) while our write lands.
            await t.h.env.SANDBOX_DB.prepare('UPDATE sandboxes SET policy_generation = ? WHERE id = ?').bind(Number.MAX_SAFE_INTEGER, t.id).run()
          }
          return t.life.provider.updateNetworkPolicy(sessionId, policy)
        }
      }
    }
    const applied = await applySandboxPolicy(deps, await t.row(), 'refresh')
    expect(applied.applied).toBe(true)
    expect(writes).toEqual(['stale', 'fresh'])
  })
})
