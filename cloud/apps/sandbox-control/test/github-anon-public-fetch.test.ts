// A workspace on a public repo that Orca's GitHub App isn't installed on gets no App
// token, so its git sends no credential. When a member connected GitHub, their placeholder rules on
// github.com must not end in the firewall's 403: that 403'd the doctor's `git ls-remote` ("This
// workspace can't reach <repo> on GitHub right now") and every plain fetch and pull.
import { describe, expect, it } from 'vitest'
import { EGRESS_DENIED_BODY, type NetworkPolicy } from '../src/network-policy'
import { createHarness } from './harness'

const PROXY_URL = 'https://sandbox.test/v1/egress/proxy'
const REPO = 'https://github.com/acme/public-app'
const OP = 'o'.repeat(40)

const deniesUnclaimed = (policy: NetworkPolicy, host: string) =>
  (policy.allow[host] ?? []).some((rule) => 'response' in rule && rule.response.body === EGRESS_DENIED_BODY)

async function setup(appToken: boolean) {
  // The dev seed stores the member's token from a mint, so the App answers until the member is in.
  let mints = true
  const h = await createHarness(
    { EGRESS_PROXY_URL: PROXY_URL, SECRETS_KEK: Buffer.alloc(32, 7).toString('base64'), OPERATOR_TOKEN: OP },
    {
      credentials: { authorizationFor: async () => 'Bearer ghs_app' },
      github: {
        tokenForRepo: async () => (appToken || mints ? { token: 'ghs_repo_token', expiresAt: h.now() + 3_600_000 } : null),
        installationForRepo: async () => null
      } as never
    }
  )
  await h.call('POST', '/v1/internal/dev/member-github', {
    bearer: OP,
    body: { accountId: 'org:acme', userId: 'alice', repoUrl: REPO, login: 'alice-gh', githubUserId: 11, name: 'alice name' }
  })
  mints = false
  const alice = await h.token('alice', 'acme', 'sandbox', { org_role: 'member' })
  const created = await h.call('POST', '/v1/sandboxes', {
    bearer: alice,
    body: { workspaceId: 'ws-public', machineSize: 'standard', repo: { url: REPO }, visibility: 'team' }
  })
  expect(created.status).toBe(200)
  const id: string = created.body.sandbox.id
  const box = () => [...h.vercel.boxes.values()].find((b) => b.params.tags?.orcaSandbox === id)!
  return { h, alice, id, box }
}

describe('public repo, no App install, a member connected GitHub', () => {
  it('create: github.com carries the member claim and lets anonymous git through', async () => {
    const t = await setup(false)
    const policy = t.box().policy
    expect(policy.allow['github.com']?.some((rule) => 'forwardURL' in rule)).toBe(true)
    expect(deniesUnclaimed(policy, 'github.com')).toBe(false)
  })

  it('wake rewrites a policy written before the fix (a resumed session keeps its last policy)', async () => {
    const t = await setup(false)
    expect((await t.h.call('POST', `/v1/sandboxes/${t.id}/suspend`, { bearer: t.alice })).status).toBe(200)
    const stale = t.box().policy
    t.box().policy = {
      allow: { ...stale.allow, 'github.com': [...(stale.allow['github.com'] ?? []), { response: { statusCode: 403, body: EGRESS_DENIED_BODY, contentType: 'text/plain' } }] }
    }
    expect((await t.h.call('POST', `/v1/sandboxes/${t.id}/resume`, { bearer: t.alice })).status).toBe(200)
    expect(deniesUnclaimed(t.box().policy, 'github.com')).toBe(false)
  })

  it('with an App token github.com stays fail-closed', async () => {
    const t = await setup(true)
    expect(deniesUnclaimed(t.box().policy, 'github.com')).toBe(true)
  })
})
