// LIVE-GIT-ACCESS: the GitHub App installed after a workspace booted reaches the running VM without a
// restart: POST /v1/sandboxes/:id/git/access mints the repo token, swaps it into the live egress policy
// and gives the VM's git the placeholder header boot would have set.
import { describe, expect, it } from 'vitest'
import { GIT_EXTRAHEADER_SCRIPT, githubPlaceholderToken } from '../src/lifecycle'
import { EGRESS_DENIED_BODY, gitBasicAuthorization } from '../src/network-policy'
import { getSandbox } from '../src/store'
import { createHarness } from './harness'

const PROXY_URL = 'https://sandbox.test/v1/egress/proxy'
const REPO = 'https://github.com/acme/app'

async function setup() {
  const installed = { on: false }
  const h = await createHarness(
    { EGRESS_PROXY_URL: PROXY_URL, SECRETS_KEK: Buffer.alloc(32, 7).toString('base64') },
    {
      credentials: { authorizationFor: async () => 'Bearer ghs_app' },
      github: {
        tokenForRepo: async () => (installed.on ? { token: 'ghs_repo_token', expiresAt: h.now() + 3_600_000 } : null),
        installationForRepo: async () => null
      } as never
    }
  )
  // The VM's git config takes the header (a real VM's bash exits 0).
  h.vercel.commandHandler = (params) =>
    params.command === 'bash' && params.args?.[1] === GIT_EXTRAHEADER_SCRIPT ? { exitCode: 0, stdout: '', stderr: '' } : undefined
  const alice = await h.token('alice', 'acme', 'sandbox', { org_role: 'member' })
  const created = await h.call('POST', '/v1/sandboxes', {
    bearer: alice,
    body: { workspaceId: 'ws-1', machineSize: 'standard', repo: { url: REPO } }
  })
  expect(created.status).toBe(200)
  const id: string = created.body.sandbox.id
  const box = () => [...h.vercel.boxes.values()].find((b) => b.params.tags?.orcaSandbox === id)!
  const gitConfigRuns = () => h.vercel.commands.filter((c) => c.command === 'bash' && c.args?.[1] === GIT_EXTRAHEADER_SCRIPT)
  return { h, alice, id, box, installed, gitConfigRuns }
}

describe('LIVE-GIT-ACCESS', () => {
  it('not installed yet: says so and changes nothing', async () => {
    const t = await setup()
    const res = await t.h.call('POST', `/v1/sandboxes/${t.id}/git/access`, { bearer: t.alice })
    expect(res.body).toEqual({ applied: false, reason: 'not_installed' })
    expect(t.gitConfigRuns()).toHaveLength(0)
  })

  it('installed after boot: the token goes into the live policy and the VM git gets the placeholder, no restart', async () => {
    const t = await setup()
    const row = (await getSandbox(t.h.env.SANDBOX_DB, t.id))!
    expect(row.github_token_expires_at).toBeNull()
    t.installed.on = true
    const res = await t.h.call('POST', `/v1/sandboxes/${t.id}/git/access`, { bearer: t.alice })
    expect(res.body).toMatchObject({ applied: true })
    const placeholder = gitBasicAuthorization(githubPlaceholderToken(row))
    const github = t.box().policy.allow['github.com'] ?? []
    expect(JSON.stringify(github)).toContain(placeholder)
    expect(github.some((rule) => 'forwardURL' in rule && rule.forwardURL === PROXY_URL)).toBe(true)
    expect(github.at(-1)).toMatchObject({ response: { statusCode: 403, body: EGRESS_DENIED_BODY } })
    // The real token never reaches the policy or the VM.
    expect(JSON.stringify(t.box().policy)).not.toContain('ghs_repo_token')
    const run = t.gitConfigRuns().at(-1)!
    expect(run.args?.[3]).toBe(`Authorization: ${placeholder}`)
    expect(JSON.stringify(run)).not.toContain('ghs_repo_token')
    expect((await getSandbox(t.h.env.SANDBOX_DB, t.id))!.github_token_expires_at).not.toBeNull()
    // Repeating it is harmless.
    expect((await t.h.call('POST', `/v1/sandboxes/${t.id}/git/access`, { bearer: t.alice })).body).toMatchObject({ applied: true })
  })

  it('a sleeping workspace: not_running (its next wake mints the token itself)', async () => {
    const t = await setup()
    expect((await t.h.call('POST', `/v1/sandboxes/${t.id}/suspend`, { bearer: t.alice })).status).toBe(200)
    t.installed.on = true
    expect((await t.h.call('POST', `/v1/sandboxes/${t.id}/git/access`, { bearer: t.alice })).body).toEqual({ applied: false, reason: 'not_running' })
  })

  it('someone else’s workspace is not found', async () => {
    const t = await setup()
    const bob = await t.h.token('bob', 'acme', 'sandbox', { org_role: 'member' })
    expect((await t.h.call('POST', `/v1/sandboxes/${t.id}/git/access`, { bearer: bob })).status).toBe(404)
  })
})
