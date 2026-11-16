// EGRESS firewall mode (design §1, §3, §4, §7): the firewall swaps the values itself; the egress proxy keeps
// only the cases it can't do (W1 Cursor's filtered exchange, W2 the Copilot PAT's prefix scope, W3 members).
import { describe, expect, it } from 'vitest'
import { lifecycleDeps } from '../src/index'
import { githubPlaceholderHeaders, githubPlaceholderToken, policyConfigHash } from '../src/lifecycle'
import { EGRESS_DENIED_BODY, KEYS_WITHHELD_BODY, gitBasicAuthorization, type NetworkPolicyRule } from '../src/network-policy'
import { reconcile } from '../src/reconcile'
import { secretPlaceholder } from '../src/secret-egress'
import { getSandbox } from '../src/store'
import { createHarness } from './harness'

const KEK = Buffer.alloc(32, 7).toString('base64')
const PROXY_URL = 'https://sandbox.test/v1/egress/proxy'
const OP = 'o'.repeat(40)
const SETUP_TOKEN = 'sk-ant-oat01-FAKEsetupTOKEN_for_tests_only_000000000000'
const ANTHROPIC_KEY = 'sk-ant-api03-REALkeyFORtests0000000000000000000000000000'
const CURSOR_KEY = 'key_cursor_REAL_for_tests_00000000000000'
const APP_TOKEN = 'ghs_REAL_app_token_for_tests'

async function setup(overrides: Record<string, string> = {}) {
  const h = await createHarness(
    { SECRETS_KEK: KEK, EGRESS_PROXY_URL: PROXY_URL, SECRETS_EGRESS_PLACEHOLDERS: 'on', AGENT_ACCOUNTS_CLAUDE: 'on', OPERATOR_TOKEN: OP, EGRESS_SWAP_MODE: 'firewall', ...overrides },
    {
      credentials: { authorizationFor: async () => null },
      github: { tokenForRepo: async () => ({ token: APP_TOKEN, expiresAt: h.now() + 3_600_000 }), installationForRepo: async () => null } as never
    }
  )
  const mia = await h.token('mia', 'acme', 'sandbox', { org_role: 'member' })
  const secret = (name: string, value: string) => h.call('PUT', `/v1/secrets/personal/${name}`, { body: { value }, bearer: mia })
  const create = async () => {
    const created = await h.call('POST', '/v1/sandboxes', { bearer: mia, body: { workspaceId: `ws-${Math.random()}`, machineSize: 'standard', repo: { url: 'https://github.com/acme/app' } } })
    expect(created.status).toBe(200)
    const id: string = created.body.sandbox.id
    const box = () => [...h.vercel.boxes.values()].find((b) => b.params.tags.orcaSandbox === id)!
    const rules = (host: string) => (box().policy.allow[host] ?? []) as (NetworkPolicyRule & { match?: { headers?: { value: { exact?: string } }[] } })[]
    return { id, box, rules, row: async () => (await getSandbox(h.env.SANDBOX_DB, id))! }
  }
  return { h, mia, secret, create }
}

const claims = (rules: { match?: { headers?: { value: { exact?: string } }[] } }[], placeholder: string) =>
  rules.filter((rule) => rule.match?.headers?.some((header) => header.value.exact === placeholder))

describe('EGRESS firewall mode', () => {
  it('model keys are swapped by the firewall in every header form, then the 403; the proxy is not involved', async () => {
    const { secret, create } = await setup()
    expect((await secret('ANTHROPIC_API_KEY', ANTHROPIC_KEY)).status).toBe(200)
    const { id, rules } = await create()
    const ph = secretPlaceholder({ id }, 'ANTHROPIC_API_KEY')
    const anthropic = rules('api.anthropic.com')
    expect(claims(anthropic, ph)).toEqual([{ match: { headers: [{ key: { exact: 'x-api-key' }, value: { exact: ph } }] }, transform: [{ headers: { 'x-api-key': ANTHROPIC_KEY } }] }])
    expect(claims(anthropic, `Bearer ${ph}`)[0]).toMatchObject({ transform: [{ headers: { authorization: `Bearer ${ANTHROPIC_KEY}` } }] })
    expect(anthropic.some((rule) => 'forwardURL' in rule)).toBe(false)
    expect(anthropic.at(-1)).toEqual({ response: { statusCode: 403, body: EGRESS_DENIED_BODY, contentType: 'text/plain' } })
  })

  it('the GitHub App token is swapped by the firewall for git and the API, in the scheme the client sent', async () => {
    const { create } = await setup()
    const { id, rules } = await create()
    const row = { id } as never
    const git = gitBasicAuthorization(githubPlaceholderToken(row))
    expect(claims(rules('github.com'), git)[0]).toMatchObject({ transform: [{ headers: { authorization: gitBasicAuthorization(APP_TOKEN) } }] })
    const [bearer, token] = githubPlaceholderHeaders(row)
    // APPROVALS-REFUSED: the firewall swaps reads only (GET/HEAD); anything else, any method, goes to the proxy.
    for (const [placeholder, scheme] of [[bearer!, 'Bearer'], [token!, 'token']] as const) {
      const [swap, forward] = claims(rules('api.github.com'), placeholder)
      expect(swap).toMatchObject({ match: { path: { startsWith: '/' }, method: ['GET', 'HEAD'] }, transform: [{ headers: { authorization: `${scheme} ${APP_TOKEN}` } }] })
      expect(forward).toMatchObject({ forwardURL: expect.any(String) })
      expect((forward as { match: { method?: unknown } }).match.method).toBeUndefined()
    }
  })

  it('W1: Cursor’s key exchange stays on the egress proxy (its reply is filtered), never in the policy', async () => {
    const { secret, create, h } = await setup()
    await secret('CURSOR_API_KEY', CURSOR_KEY)
    const { rules, box } = await create()
    const cursor = Object.keys(box().policy.allow).find((host) => host.includes('cursor'))!
    expect(rules(cursor).some((rule) => 'forwardURL' in rule)).toBe(true)
    expect(JSON.stringify(box().policy)).not.toContain(CURSOR_KEY)
    expect(h).toBeDefined()
  })

  it('a Claude sign-in: the firewall swaps it; signed out, the firewall itself answers in Anthropic’s shape', async () => {
    const { h, mia, create } = await setup()
    expect((await h.call('PUT', '/v1/agent-credentials/claude', { bearer: mia, body: { token: SETUP_TOKEN } })).status).toBe(200)
    const { rules, box, row } = await create()
    const swaps = rules('api.anthropic.com').filter((rule) => 'transform' in rule)
    expect(JSON.stringify(swaps)).toContain(SETUP_TOKEN)
    // Signed out: the next policy write (here the delete's own refresh) answers the placeholder at the firewall.
    expect((await h.call('DELETE', '/v1/agent-credentials/claude', { bearer: mia })).status).toBe(200)
    const life = (await lifecycleDeps(h.env, h.deps))!
    const { applySandboxPolicy } = await import('../src/lifecycle')
    await applySandboxPolicy(life, await row(), 'account_signed_out')
    expect(JSON.stringify(box().policy)).not.toContain(SETUP_TOKEN)
  })

  it('EGRESS_FIREWALL_CLASSES narrows it: model keys back on the proxy', async () => {
    const { secret, create } = await setup({ EGRESS_FIREWALL_CLASSES: 'github_app' })
    await secret('ANTHROPIC_API_KEY', ANTHROPIC_KEY)
    const { rules, box } = await create()
    expect(rules('api.anthropic.com').some((rule) => 'forwardURL' in rule)).toBe(true)
    expect(JSON.stringify(box().policy.allow['api.anthropic.com'])).not.toContain(ANTHROPIC_KEY)
  })

  it('APPROVALS-REFUSED: with the App token on the firewall, only GET/HEAD are swapped; every other method goes to the proxy', async () => {
    const { egressPolicy } = await import('../src/lifecycle')
    const { h } = await setup()
    const life = (await lifecycleDeps(h.env, h.deps))!
    const row = { id: 'sbx_x', repo_url: 'https://github.com/acme/app', egress_secret_hosts: null, egress_allow_hosts: null, egress_user_hosts: null } as never
    const policy = egressPolicy(life, row, 'ghs_app_token', [], { classes: new Set(['github_app']), full: true, accounts: [], secrets: new Map() })
    const api = policy.allow['api.github.com']!
    const transforms = api.filter((rule) => 'transform' in rule) as { match: { path: unknown; method?: unknown } }[]
    expect(transforms.length).toBeGreaterThan(0)
    for (const rule of transforms) {
      expect([rule.match.path, rule.match.method]).toEqual([{ startsWith: '/' }, ['GET', 'HEAD']])
    }
    const forwards = api.filter((rule) => 'forwardURL' in rule) as { match: { method?: unknown; path?: unknown } }[]
    expect(forwards.length).toBeGreaterThan(0)
    expect(forwards.every((rule) => rule.match.method === undefined && rule.match.path === undefined)).toBe(true)
    // The swaps come first (reads), then the catch-all forward; the token is only in the swaps.
    expect(api.findIndex((rule) => 'transform' in rule)).toBeLessThan(api.findIndex((rule) => 'forwardURL' in rule))
    expect(JSON.stringify(forwards)).not.toContain('ghs_app_token')
  })

  it('a key that is no longer usable is answered by the firewall, never sent upstream as a placeholder', async () => {
    const { egressPolicy } = await import('../src/lifecycle')
    const { h } = await setup()
    const life = (await lifecycleDeps(h.env, h.deps))!
    const row = { id: 'sbx_x', egress_secret_hosts: 'ANTHROPIC_API_KEY@api.anthropic.com', egress_allow_hosts: null, egress_user_hosts: null } as never
    const policy = egressPolicy(life, row, undefined, [], { classes: new Set(['model_key']), full: true, accounts: [], secrets: new Map([['ANTHROPIC_API_KEY', null]]) })
    const anthropic = policy.allow['api.anthropic.com']!
    expect(anthropic.filter((rule) => 'response' in rule && rule.response.body === KEYS_WITHHELD_BODY).length).toBeGreaterThan(0)
    expect(anthropic.some((rule) => 'forwardURL' in rule || 'transform' in rule)).toBe(false)
  })

  it('operator: one sandbox back to proxy mode, applied at once; reconcile re-applies when the config hash changes', async () => {
    const { h, secret, create } = await setup()
    await secret('ANTHROPIC_API_KEY', ANTHROPIC_KEY)
    const { id, box, row } = await create()
    const set = await h.call('POST', `/v1/internal/sandboxes/${id}/egress-mode`, { bearer: OP, body: { mode: 'proxy' } })
    expect(set.body).toMatchObject({ mode: 'proxy', applied: true })
    expect(JSON.stringify(box().policy)).not.toContain(ANTHROPIC_KEY)
    const life = (await lifecycleDeps(h.env, h.deps))!
    expect((await row()).policy_config_hash).toBe(await policyConfigHash(life, await row()))
    // An operator input changes (here: a stale hash stands in for it): the next tick re-applies.
    await h.env.SANDBOX_DB.prepare("UPDATE sandboxes SET policy_config_hash = 'old' WHERE id = ?").bind(id).run()
    box().policy = { allow: {} }
    await reconcile(life)
    expect(Object.keys(box().policy.allow).length).toBeGreaterThan(0)
    expect((await row()).policy_config_hash).toBe(await policyConfigHash(life, await row()))
  })
})

describe('review fixes (F1–F3)', () => {
  it('F1: a Copilot PAT never becomes a firewall transform, on any host', async () => {
    const { secret, create } = await setup()
    const pat = 'github_pat_REAL_for_tests_000000000000000000000000000000'
    expect((await secret('COPILOT_GITHUB_TOKEN', pat)).status).toBe(200)
    const { box } = await create()
    expect(JSON.stringify(box().policy)).not.toContain(pat)
    for (const rules of Object.values(box().policy.allow)) {
      for (const rule of rules as { transform?: { headers: Record<string, string> }[] }[]) {
        expect(JSON.stringify(rule.transform ?? '')).not.toContain('github_pat_REAL')
      }
    }
  })

  it('F3: only a config change that removes access counts as narrowing', async () => {
    const { configChangeNarrows } = await import('../src/lifecycle')
    const cfg = (mode: string, classes: string[], accounts: Record<string, boolean>, preset = 'open') => JSON.stringify({ h: 'x', mode, classes, accounts, preset })
    const base = cfg('firewall', ['claude', 'model_key'], { claude: true, codex: true })
    expect(configChangeNarrows(base, cfg('proxy', [], { claude: true, codex: true }))).toBe(true)
    expect(configChangeNarrows(base, cfg('firewall', ['model_key'], { claude: true, codex: true }))).toBe(true)
    expect(configChangeNarrows(base, cfg('firewall', ['claude', 'model_key'], { claude: false, codex: true }))).toBe(true)
    expect(configChangeNarrows(base, cfg('firewall', ['claude', 'model_key'], { claude: true, codex: true }, 'limited'))).toBe(true)
    // Widening or neutral: a new class, a provider turned on, an allowlist-only change (same summary).
    expect(configChangeNarrows(base, cfg('firewall', ['claude', 'codex', 'model_key'], { claude: true, codex: true }))).toBe(false)
    expect(configChangeNarrows(base, base)).toBe(false)
    // A pre-F3 bare-hash stamp is retried, not failed closed; unreadable history is.
    expect(configChangeNarrows('402ed84513da7fac4ec3506d', base)).toBe(false)
    expect(configChangeNarrows('{broken', base)).toBe(true)
  })
})
