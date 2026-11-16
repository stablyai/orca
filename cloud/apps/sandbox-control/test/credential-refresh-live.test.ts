// Against a running sandbox (harness + fake Vercel): the GitHub App token in the live policy
// rotates every hour with no gap, and a recorded credential change reaches the policy on the next tick.
import { describe, expect, it } from 'vitest'
import { codexTick, credentialTick } from '../src/index'
import { markCredentialChanged } from '../src/credential-outbox'
import { gitBasicAuthorization } from '../src/network-policy'
import { createHarness } from './harness'

const MIN = 60_000
const REPO = 'https://github.com/nwparker/orca-sandbox-push-test.git'

/** The installation token a policy's github.com claim swaps in, decoded from its Basic value. */
function policyToken(policy: { allow: Record<string, unknown[]> }): string | null {
  const rule = policy.allow['github.com']?.[0] as { transform?: { headers: Record<string, string> }[] } | undefined
  const basic = rule?.transform?.[0]?.headers.authorization
  return basic ? atob(basic.slice('Basic '.length)).split(':')[1]! : null
}

describe('GitHub App installation token rotation (1 h tokens)', () => {
  it('keeps a valid token in the running policy for 4 hours of 5-minute reconcile ticks', async () => {
    const minted = new Map<string, number>()
    let n = 0
    const h = await createHarness({}, {
      github: {
        tokenForRepo: async () => {
          const token = `ghs_${++n}`
          minted.set(token, h.now() + 60 * MIN)
          return { token, expiresAt: minted.get(token)! }
        },
        getInstallation: async () => null,
        getRepoInstallation: async () => null
      }
    })
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-rot', machineSize: 'standard', repo: { url: REPO } } })
    expect(created.status).toBe(200)
    const [box] = [...h.vercel.boxes.values()]
    const seen = new Set<string>()
    for (let tick = 0; tick < 48; tick++) {
      h.advance(5 * MIN)
      // Renew the lease the way a desktop does, so the sandbox stays up.
      await h.env.SANDBOX_DB.prepare('UPDATE sandboxes SET lease_expires_at = ?').bind(h.now() + 60 * MIN).run()
      await h.reconcile()
      const token = policyToken(box!.policy)!
      seen.add(token)
      // Never expired, and never closer than 10 min to expiry, at any tick.
      expect(minted.get(token)! - h.now()).toBeGreaterThanOrEqual(10 * MIN)
    }
    // About one rotation every 40 min (rotated with <20 min left): 4 h = 6 rotations, give or take one.
    expect(seen.size).toBeGreaterThanOrEqual(5)
    expect(seen.size).toBeLessThanOrEqual(8)
  })
})

describe('credential tick', () => {
  it('pushes a recorded change into the running policy, and retries until it lands', async () => {
    let n = 0
    const h = await createHarness({}, {
      github: {
        tokenForRepo: async () => ({ token: `ghs_${++n}`, expiresAt: h.now() + 60 * MIN }),
        getInstallation: async () => null,
        getRepoInstallation: async () => null
      }
    })
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-tick', machineSize: 'standard', repo: { url: REPO } } })
    const [box] = [...h.vercel.boxes.values()]
    const before = policyToken(box!.policy)
    const userId = (await h.env.SANDBOX_DB.prepare('SELECT user_id FROM sandboxes WHERE id = ?').bind(created.body.sandbox.id).first<{ user_id: string }>())!.user_id
    // A renewed sign-in (a widening push): only its state matters here, never its value.
    await h.env.SANDBOX_DB.prepare(
      `INSERT INTO agent_credentials (user_id, account_id, agent, kek_id, wrapped_dek, ciphertext, state, created_at, updated_at) VALUES (?, ?, 'claude', 'k', 'd', 'c', 'active', 1, 1)`
    ).bind(userId, `user:${userId}`).run()
    await markCredentialChanged(h.env.SANDBOX_DB, { kind: 'account', agent: 'claude', userId }, h.now())
    // Vercel refuses every policy write of the first tick (applySandboxPolicy tries 3 times): the change stays pending.
    const update = h.vercel.updateNetworkPolicy
    let refuse = 3
    h.vercel.updateNetworkPolicy = async (sessionId, policy) => {
      if (refuse > 0) {
        refuse--
        throw new Error('vercel 503')
      }
      return update.call(h.vercel, sessionId, policy)
    }
    await credentialTick(h.env, false, h.deps)
    expect(policyToken(box!.policy)).toBe(before)
    h.advance(61_000)
    await credentialTick(h.env, false, h.deps)
    expect(policyToken(box!.policy)).not.toBe(before)
    expect(box!.policy.allow['github.com']![0]).toMatchObject({ transform: [{ headers: { authorization: gitBasicAuthorization(`ghs_${n}`) } }] })
    const row = await h.env.SANDBOX_DB.prepare('SELECT pushed_at, changed_at FROM credential_pushes').first<{ pushed_at: number; changed_at: number }>()
    expect(row!.pushed_at).toBe(row!.changed_at)
  })

  it('a narrowing push Vercel keeps refusing puts the sandbox to sleep (fail closed)', async () => {
    const h = await createHarness({}, {
      github: { tokenForRepo: async () => ({ token: 'ghs_x', expiresAt: h.now() + 60 * MIN }), getInstallation: async () => null, getRepoInstallation: async () => null }
    })
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-narrow', machineSize: 'standard', repo: { url: REPO } } })
    const id = created.body.sandbox.id as string
    const userId = (await h.env.SANDBOX_DB.prepare('SELECT user_id FROM sandboxes WHERE id = ?').bind(id).first<{ user_id: string }>())!.user_id
    // No credential row any more: 'credential_deleted', a narrowing reason.
    await markCredentialChanged(h.env.SANDBOX_DB, { kind: 'account', agent: 'claude', userId }, h.now())
    h.vercel.updateNetworkPolicy = async () => {
      throw new Error('vercel 503')
    }
    await credentialTick(h.env, false, h.deps)
    const status = (await h.env.SANDBOX_DB.prepare('SELECT status FROM sandboxes WHERE id = ?').bind(id).first<{ status: string }>())!.status
    expect(status).not.toBe('running')
  })
})

describe('Codex: a near-expiry login with a dead refresh token (dev rehearsal route)', () => {
  const KEK = Buffer.alloc(32, 7).toString('base64')
  const OPERATOR = 'o'.repeat(40)
  const jwt = (claims: Record<string, unknown>) =>
    `${btoa(JSON.stringify({ alg: 'none' }))}.${btoa(JSON.stringify(claims)).replaceAll('=', '')}.sig`

  it('is refreshed ahead of expiry, ends as revoked (Renew), and the change is pushed', async () => {
    const tokenCalls: string[] = []
    const h = await createHarness(
      { SECRETS_KEK: KEK, OPERATOR_TOKEN: OPERATOR, AGENT_ACCOUNTS_CODEX: 'on', EGRESS_PROXY_URL: 'https://sandbox.test/v1/egress/proxy' },
      {
        codexTokenFetch: async (_url, init) => {
          tokenCalls.push(String(init?.body))
          return Response.json({ error: { code: 'refresh_token_invalidated' } }, { status: 401 })
        }
      }
    )
    const store = (body: unknown) =>
      h.send(new Request('https://sandbox.test/v1/internal/dev/codex-login', { method: 'POST', headers: { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    // Only throwaway dev identities.
    expect((await store({ accountId: 'user:mia', userId: 'mia', tokens: { access_token: 'a', refresh_token: 'r', id_token: 'i' } })).status).toBe(400)
    const stored = await store({
      accountId: 'dev:mia',
      userId: 'mia',
      tokens: { access_token: jwt({ exp: Math.floor(h.now() / 1000) + 3600 }), refresh_token: 'rt_bogus', id_token: jwt({ email: 'mia@example.com' }) }
    })
    expect(stored.status).toBe(200)
    expect((await h.call('GET', '/v1/agent-credentials', { as: 'mia' })).body.codex.state).toBe('active')
    await codexTick(h.env, true, h.deps)
    expect(tokenCalls).toHaveLength(1)
    expect(JSON.parse(tokenCalls[0]!)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt_bogus' })
    expect((await h.call('GET', '/v1/agent-credentials', { as: 'mia' })).body.codex.state).toBe('revoked')
    // A dead login is never retried.
    h.advance(10 * MIN)
    await codexTick(h.env, true, h.deps)
    expect(tokenCalls).toHaveLength(1)
    const push = await h.env.SANDBOX_DB.prepare(`SELECT kind, subject FROM credential_pushes WHERE kind = 'account:codex'`).first()
    expect(push).toEqual({ kind: 'account:codex', subject: 'mia' })
  })
})
