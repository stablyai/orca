import { exportPKCS8, generateKeyPair, decodeJwt } from 'jose'
import { describe, expect, it } from 'vitest'
import { createGitHubAppMinter } from '../src/github-app'
import { gitBasicAuthorization } from '../src/network-policy'
import { START_COMMAND } from '../src/sandbox-vm-commands'
import { createHarness } from './harness'

const MIN = 60_000

describe('GitHub App installation tokens', () => {
  it('mints a token scoped to the one workspace repo and reuses it until near expiry', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true })
    const calls: { method: string; path: string; body: unknown; iss: unknown }[] = []
    let now = Date.parse('2026-11-09T00:00:00Z')
    const minter = createGitHubAppMinter({
      appId: '123',
      privateKeyPkcs8: await exportPKCS8(privateKey),
      now: () => now,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname
        const jwt = new Headers(init?.headers).get('authorization')!.replace('Bearer ', '')
        calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(String(init.body)) : undefined, iss: decodeJwt(jwt).iss })
        return path.endsWith('/installation')
          ? Response.json({ id: 77 })
          : Response.json({ token: 'ghs_minted', expires_at: new Date(now + 60 * MIN).toISOString() })
      }
    })
    expect(await minter.tokenForRepo('https://github.com/nwparker/orca-sandbox-push-test.git')).toEqual({ token: 'ghs_minted', expiresAt: now + 60 * MIN })
    expect(calls).toEqual([
      { method: 'GET', path: '/repos/nwparker/orca-sandbox-push-test/installation', body: undefined, iss: '123' },
      {
        method: 'POST',
        path: '/app/installations/77/access_tokens',
        body: { repositories: ['orca-sandbox-push-test'], permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } },
        iss: '123'
      }
    ])
    now += 30 * MIN
    await minter.tokenForRepo('https://github.com/nwparker/orca-sandbox-push-test')
    expect(calls).toHaveLength(2)
    now += 26 * MIN
    await minter.tokenForRepo('https://github.com/nwparker/orca-sandbox-push-test')
    expect(calls).toHaveLength(4)
    expect(await minter.tokenForRepo('https://gitlab.com/a/b')).toBeNull()
  })

  it('injects the repo token for git and refreshes it before it expires', async () => {
    let expiresAt = 0
    const h = await createHarness({}, {
      github: { tokenForRepo: async () => ({ token: `ghs_${expiresAt}`, expiresAt }) }
    })
    expiresAt = h.now() + 60 * MIN
    const { body } = await h.call('POST', '/v1/sandboxes', {
      body: { workspaceId: 'ws-git', machineSize: 'standard', repo: { url: 'https://github.com/nwparker/orca-sandbox-push-test.git' } }
    })
    const placeholder = gitBasicAuthorization(`orca-ph-${body.sandbox.id}`)
    const [box] = [...h.vercel.boxes.values()]
    expect(box!.policy.allow['github.com']![0]).toEqual({
      match: { headers: [{ key: { exact: 'authorization' }, value: { exact: placeholder } }] },
      transform: [{ headers: { authorization: gitBasicAuthorization(`ghs_${expiresAt}`) } }]
    })
    const start = h.vercel.commands.find((c) => c.command === START_COMMAND)!
    expect(start.env.ORCA_GIT_EXTRAHEADER).toBe(`Authorization: ${placeholder}`)
    expect(start.env.ORCA_REPO_URL).toBe('https://github.com/nwparker/orca-sandbox-push-test.git')

    const first = expiresAt
    h.advance(50 * MIN)
    expiresAt = h.now() + 60 * MIN
    await h.reconcile()
    expect(box!.policy.allow['github.com']![0]).toMatchObject({ transform: [{ headers: { authorization: gitBasicAuthorization(`ghs_${expiresAt}`) } }] })
    expect(expiresAt).not.toBe(first)
  })
})
