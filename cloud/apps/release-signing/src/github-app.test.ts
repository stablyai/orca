import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createSigningApis } from './github-app.js'
import type { SigningConfig } from './config.js'

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const config: SigningConfig = {
  repository: 'stablyai/orca',
  appId: '12',
  installationId: 34,
  privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  githubWebhookSecret: 'unused',
  signpathWebhookSecret: 'unused',
  reconcileSecret: 'unused',
  signpathToken: 'private-signpath-token',
  signpathOrganization: '11111111-1111-4111-8111-111111111111',
  signpathProject: 'orca',
  policies: []
}
describe('upstream authentication', () => {
  it('shares a narrowly scoped installation token and signs a valid app JWT', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('/access_tokens'))
        return Response.json({
          token: 'installation-token',
          expires_at: new Date(Date.now() + 3600_000).toISOString()
        })
      return Response.json({})
    })
    const apis = createSigningApis(config, fetcher)
    await Promise.all([
      apis.github('/repos/stablyai/orca/actions/runs/1'),
      apis.github('/repos/stablyai/orca/actions/runs/2')
    ])
    const tokens = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/access_tokens'))
    expect(tokens).toHaveLength(1)
    const init = tokens[0]![1]!
    expect(JSON.parse(init.body as string)).toEqual({
      repositories: ['orca'],
      permissions: { actions: 'read', contents: 'read', deployments: 'write' }
    })
    const jwt = (init.headers as Record<string, string>).authorization!.slice(7)
    const [header, claims, signature] = jwt.split('.')
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${claims}`),
        keys.publicKey,
        Buffer.from(signature!, 'base64url')
      )
    ).toBe(true)
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({ iss: '12' })
    for (const [, request] of fetcher.mock.calls) expect(request?.redirect).toBe('error')
    expect((fetcher.mock.calls[1]![1]!.headers as Record<string, string>).authorization).toBe(
      'Bearer installation-token'
    )
  })
  it('rejects repository and signing request scope before network calls', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const apis = createSigningApis(config, fetcher)
    await expect(apis.github('/repos/evil/orca/actions/runs/1')).rejects.toThrow('scope')
    await expect(apis.signpath('../other')).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('does not disclose upstream error bodies or credentials', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('private error material', { status: 403 }))
    const apis = createSigningApis(config, fetcher)
    await expect(apis.signpath('22222222-2222-4222-8222-222222222222')).rejects.toThrow(
      'Upstream request failed (403): SignPath request'
    )
  })
})
