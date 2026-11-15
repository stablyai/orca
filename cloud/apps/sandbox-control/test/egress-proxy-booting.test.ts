// CLONE-BEFORE-RUNNING: a booting VM uses its credential routes before the control plane records it
// running (the create's clone of an App-installed private repo, a wake's git). The egress proxy
// refused every row that wasn't `running`, so those clones got `remote: sandbox_not_running` (403)
// and a fresh workspace opened empty. It now serves creating/resuming rows too, only for the sandbox
// Vercel's OIDC token names; every other state is still refused.
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { describe, expect, it } from 'vitest'
import { gitBasicAuthorization } from '../src/network-policy'
import type { RunCommandParams } from '../src/sandbox-provider'
import { START_COMMAND } from '../src/sandbox-vm-commands'
import type { SandboxStatus } from '../src/store'
import { createHarness } from './harness'

const PROXY_URL = 'https://sandbox.test/v1/egress/proxy'
const ISSUER = 'https://oidc.vercel.com/team_orca'
const REPO = 'https://github.com/acme/private-app'

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'v1', alg: 'RS256' }] }
  const upstream: string[] = []
  const h = await createHarness(
    { EGRESS_PROXY_URL: PROXY_URL },
    {
      egressKeysForIssuer: () => createLocalJWKSet(jwks),
      credentials: { authorizationFor: async (_row, host) => (host === 'github.com' ? gitBasicAuthorization('ghs_repo_token') : null) },
      github: {
        tokenForRepo: async () => ({ token: 'ghs_repo_token', expiresAt: h.now() + 3_600_000 }),
        installationForRepo: async () => null
      } as never,
      egressFetch: async (input) => {
        upstream.push(String(input))
        return new Response('001e# service=git-upload-pack\n', { status: 200 })
      }
    }
  )
  const oidc = (sandboxName: string) =>
    new SignJWT({ team_id: 'team_orca', project_id: 'prj_orca', sandbox_id: 'sbx-v', sandbox_name: sandboxName })
      .setProtectedHeader({ alg: 'RS256', kid: 'v1' })
      .setIssuer(ISSUER)
      .setAudience(PROXY_URL)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
  /** The VM's git fetch of the repo's refs, as Vercel forwards it. */
  async function gitFetch(sandboxId: string, sandboxName = `orca-test-${sandboxId}`) {
    const response = await h.send(
      new Request(`${PROXY_URL}/acme/private-app.git/info/refs?service=git-upload-pack`, {
        headers: {
          'vercel-forwarded-host': 'github.com',
          'vercel-forwarded-scheme': 'https',
          'vercel-forwarded-port': '443',
          'vercel-forwarded-path': '/acme/private-app.git/info/refs?service=git-upload-pack',
          'vercel-sandbox-oidc-token': await oidc(sandboxName),
          authorization: gitBasicAuthorization(`orca-ph-${sandboxId}`)
        }
      })
    )
    return { status: response.status, body: await response.text() }
  }
  /** Runs `during` inside the VM's start command (the prelude clone's moment), then the start itself. */
  function duringStart(during: (sandboxId: string, status: SandboxStatus | null) => Promise<void>) {
    const handler = async (params: RunCommandParams, sessionId: string) => {
      const box = [...h.vercel.boxes.values()].find((b) => b.sessionId === sessionId)!
      const sandboxId = box.params.tags.orcaSandbox!
      const row = h.raw.prepare('SELECT status FROM sandboxes WHERE id = ?').get(sandboxId) as { status: SandboxStatus } | undefined
      await during(sandboxId, row?.status ?? null)
      h.vercel.commandHandler = undefined
      try {
        return await h.vercel.runCommand(sessionId, params)
      } finally {
        h.vercel.commandHandler = hook
      }
    }
    const hook: NonNullable<typeof h.vercel.commandHandler> = (params, sessionId) => {
      const isStart = params.command === START_COMMAND || (params.command === 'bash' && params.args?.[1]?.endsWith(`exec ${START_COMMAND}`))
      return isStart ? handler(params, sessionId) : undefined
    }
    h.vercel.commandHandler = hook
  }
  return { h, gitFetch, duringStart, upstream }
}

describe('CLONE-BEFORE-RUNNING: the egress proxy serves a booting VM its own routes', () => {
  it("create: the prelude clone's git is swapped while the row is still creating", async () => {
    const t = await setup()
    const seen: { status: SandboxStatus | null; answer: { status: number; body: string } }[] = []
    t.duringStart(async (sandboxId, status) => {
      seen.push({ status, answer: await t.gitFetch(sandboxId) })
    })
    const created = await t.h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-clone', machineSize: 'standard', repo: { url: REPO } } })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    expect(seen).toEqual([{ status: 'creating', answer: { status: 200, body: '001e# service=git-upload-pack\n' } }])
    expect(t.upstream).toEqual(['https://github.com/acme/private-app.git/info/refs?service=git-upload-pack'])
  })

  it("wake: git before the running claim is swapped while the row is resuming", async () => {
    const t = await setup()
    const created = await t.h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-wake', machineSize: 'standard', repo: { url: REPO } } })
    const id: string = created.body.sandbox.id
    expect((await t.h.call('POST', `/v1/sandboxes/${id}/suspend`)).status).toBe(200)
    const seen: { status: SandboxStatus | null; answer: number }[] = []
    t.duringStart(async (sandboxId, status) => {
      seen.push({ status, answer: (await t.gitFetch(sandboxId)).status })
    })
    expect((await t.h.call('POST', `/v1/sandboxes/${id}/resume`)).status).toBe(200)
    expect(seen).toEqual([{ status: 'resuming', answer: 200 }])
  })

  it.each<[SandboxStatus, number, string]>([
    ['creating', 200, '001e# service=git-upload-pack\n'],
    ['resuming', 200, '001e# service=git-upload-pack\n'],
    ['running', 200, '001e# service=git-upload-pack\n'],
    ['suspending', 403, 'sandbox_not_running'],
    ['suspended', 403, 'sandbox_not_running'],
    ['archived', 403, 'sandbox_not_running'],
    ['destroying', 403, 'sandbox_not_running'],
    ['destroyed', 403, 'sandbox_not_running'],
    ['failed', 403, 'sandbox_not_running']
  ])('a %s row: %i', async (status, code, body) => {
    const t = await setup()
    const created = await t.h.call('POST', '/v1/sandboxes', { body: { workspaceId: `ws-${status}`, machineSize: 'standard', repo: { url: REPO } } })
    const id: string = created.body.sandbox.id
    t.h.raw.prepare('UPDATE sandboxes SET status = ? WHERE id = ?').run(status, id)
    expect(await t.gitFetch(id)).toEqual({ status: code, body })
  })

  it('a booting row never serves another sandbox: an unknown name is refused, another VM gets only its own routes', async () => {
    const t = await setup()
    const a = (await t.h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-a', machineSize: 'standard', repo: { url: REPO } } })).body.sandbox.id as string
    const b = (await t.h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-b', machineSize: 'standard', repo: { url: REPO } } })).body.sandbox.id as string
    t.h.raw.prepare("UPDATE sandboxes SET status = 'creating' WHERE id IN (?, ?)").run(a, b)
    // VM b presenting a's placeholder: b's own routes don't carry it.
    expect(await t.gitFetch(a, `orca-test-${b}`)).toEqual({ status: 403, body: 'placeholder_missing' })
    expect(await t.gitFetch(a, 'orca-test-sbx_not_a_row')).toEqual({ status: 403, body: 'sandbox_not_running' })
    expect(t.upstream).toEqual([])
  })
})
