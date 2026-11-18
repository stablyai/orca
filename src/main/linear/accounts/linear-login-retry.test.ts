import { mkdtempSync, rmSync } from 'node:fs'
import * as realOs from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempHome = ''

async function load() {
  vi.resetModules()
  const { setSecretStore } = await import('../../../shared/secure-storage/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => false,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString('utf-8'),
    describeProtectionGap: () => null
  })
  vi.doMock('os', () => ({ ...realOs, homedir: () => tempHome }))
  return {
    client: await import('./linear-account-client'),
    store: await import('./linear-login-store')
  }
}

const linked = {
  identity: { userId: 'user-ada', name: 'Ada', handle: 'ada' },
  workspace: { id: 'org-acme', name: 'Acme', urlKey: 'acme' }
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const refused = () =>
  json(401, {
    errors: [
      {
        message: 'Authentication required, not authenticated',
        extensions: { type: 'authentication error', code: 'AUTHENTICATION_ERROR' }
      }
    ]
  })
// A fixed clock: the saved login's expiry is read against it.
const NOW = Date.parse('2026-11-02T12:00:00Z')

const viewer = () => json(200, { data: { viewer: { id: 'user-ada', name: 'Ada' } } })

beforeEach(() => {
  tempHome = mkdtempSync(join(realOs.tmpdir(), 'orca-linear-retry-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(tempHome, { recursive: true, force: true })
})

// What each Linear call carried, in order.
function linear(answers: (() => Response)[]) {
  const calls: { url: string; authorization: string | null }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization')
    })
    const next = answers.shift()
    if (!next) {
      throw new Error('unexpected Linear call')
    }
    return next()
  })
  return calls
}

describe('a login Linear refuses mid-call', () => {
  it('is refreshed and the call tried once more with the new token', async () => {
    const { client, store } = await load()
    // Still "fresh" by its saved expiry, as after a sleep that outlived the token.
    store.keepConnectedLinearLogin(
      {
        accessToken: 'access-old',
        refreshToken: 'refresh-old',
        expiresAt: NOW + 20 * 60 * 60_000,
        clientId: 'client-1'
      },
      linked
    )
    const calls = linear([
      refused,
      () =>
        json(200, { access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 86_399 }),
      viewer
    ])
    const linearClient = client.getClient('org-acme')
    await expect(linearClient?.viewer).resolves.toMatchObject({ id: 'user-ada' })
    expect(calls.map((call) => [call.url, call.authorization])).toEqual([
      ['https://api.linear.app/graphql', 'Bearer access-old'],
      ['https://api.linear.app/oauth/token', null],
      ['https://api.linear.app/graphql', 'Bearer access-new']
    ])
    expect(store.readWorkspaceLogin('org-acme')?.refreshToken).toBe('refresh-new')
  })

  it('fails with Linear’s refusal when the refresh can’t help, without retrying again', async () => {
    const { client, store } = await load()
    store.keepConnectedLinearLogin(
      {
        accessToken: 'access-old',
        refreshToken: 'refresh-old',
        expiresAt: NOW + 20 * 60 * 60_000,
        clientId: 'client-1'
      },
      linked
    )
    const calls = linear([refused, () => json(400, { error: 'invalid_grant' })])
    await expect(client.getClient('org-acme')?.viewer).rejects.toThrow(/Authentication/)
    expect(calls).toHaveLength(2)
    // Revoked for good: Orca forgets it and says to connect again.
    expect(store.readWorkspaceLogin('org-acme')).toBeNull()
  })

  it('never retries an API key', async () => {
    const { client } = await load()
    const { saveWorkspaceToken } = await import('./linear-token-store')
    const { upsertWorkspace } = await import('./linear-workspace-registry')
    saveWorkspaceToken('org-acme', 'lin_api_key')
    upsertWorkspace({
      id: 'org-acme',
      organizationId: 'org-acme',
      organizationName: 'Acme',
      displayName: 'ada',
      email: null
    })
    const calls = linear([refused])
    await expect(client.getClient('org-acme')?.viewer).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })
})
