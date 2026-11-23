import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const home = vi.hoisted(() => ({ dir: '' }))
vi.mock('node:os', async (actual) => ({
  ...(await actual<typeof os>()),
  homedir: () => home.dir
}))

const { readGoogleAccount, saveGoogleAccount } = await import('./google-credential-store')
const { runGoogleSignIn } = await import('./google-sign-in-run')

const CURRENT = {
  clientId: 'current-id',
  clientSecret: 'current-secret',
  projectId: 'current-project',
  source: 'imported' as const,
  savedAt: 1
}
const OWN = { clientId: 'own-id', clientSecret: 'own-secret' }

function idToken(email: string): string {
  const claims = Buffer.from(JSON.stringify({ sub: `sub-${email}`, email })).toString('base64url')
  return `e30.${claims}.sig`
}

/** Signs in through a fake Google that answers as `signedInAs`; returns the app each step used. */
async function signIn(signedInAs: string, loginHint?: string) {
  const used: { authorize?: string; exchange?: string } = {}
  const http = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      used.exchange = new URLSearchParams(String(init?.body)).get('client_id') ?? undefined
      return Response.json({
        access_token: 'access',
        expires_in: 3600,
        refresh_token: 'refresh',
        scope: 'openid email',
        id_token: idToken(signedInAs)
      })
    }
    return Response.json({})
  }) as unknown as typeof fetch
  let returned: (query: string) => void = () => {}
  const record = await runGoogleSignIn(
    { http, now: () => 1_000, client: () => CURRENT },
    {
      callerLoopbackPort: 4567,
      choices: [],
      openBrowser: false,
      ...(loginHint ? { loginHint } : {})
    },
    {
      signal: new AbortController().signal,
      onPrompt: (prompt) => {
        const url = new URL(prompt.authorizeUrl)
        used.authorize = url.searchParams.get('client_id') ?? undefined
        returned(`?state=${url.searchParams.get('state')}&code=the-code`)
      },
      nextCode: () => new Promise((resolve) => (returned = resolve))
    }
  )
  return { record, used }
}

async function saveAccount(email: string, extra: { reason?: string } = {}): Promise<void> {
  await saveGoogleAccount({
    email,
    client: OWN,
    projectId: 'own-project',
    refreshToken: null,
    accessToken: null,
    expiresAt: 0,
    grantedScopes: [],
    status: 'reconnect',
    services: [],
    connectedAt: 500,
    ...extra
  })
}

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), 'google-sign-in-run-'))
})

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true })
})

describe('the Google app a sign-in goes through', () => {
  it('is the saved account’s own app when it signs in again', async () => {
    await saveAccount('me@gmail.com')
    const { record, used } = await signIn('me@gmail.com', 'me@gmail.com')
    expect(used).toEqual({ authorize: 'own-id', exchange: 'own-id' })
    expect(record.client).toEqual(OWN)
    expect(record.projectId).toBe('own-project')
  })

  it('is this computer’s app for a new account', async () => {
    const { record, used } = await signIn('new@acme.com', 'new@acme.com')
    expect(used).toEqual({ authorize: 'current-id', exchange: 'current-id' })
    expect(record.client).toEqual({ clientId: 'current-id', clientSecret: 'current-secret' })
    expect(record.projectId).toBe('current-project')
  })

  it('is this computer’s app when the saved account can’t be read', async () => {
    const accounts = join(home.dir, '.orca', 'google', 'accounts')
    mkdirSync(accounts, { recursive: true })
    writeFileSync(join(accounts, `${Buffer.from('me@gmail.com').toString('base64url')}.enc`), 'x')
    const { used } = await signIn('me@gmail.com', 'me@gmail.com')
    expect(used).toEqual({ authorize: 'current-id', exchange: 'current-id' })
  })

  it('is this computer’s app when Google no longer knows the account’s own', async () => {
    const { GOOGLE_CLIENT_ENDED } = await import('./google-account-tokens')
    await saveAccount('me@gmail.com', { reason: GOOGLE_CLIENT_ENDED })
    const { used } = await signIn('me@gmail.com', 'me@gmail.com')
    expect(used).toEqual({ authorize: 'current-id', exchange: 'current-id' })
  })

  it('saves the account Google returned with the app that signed it in', async () => {
    await saveAccount('me@gmail.com')
    const { record } = await signIn('other@gmail.com', 'me@gmail.com')
    expect(record.email).toBe('other@gmail.com')
    expect((await readGoogleAccount('other@gmail.com'))?.client).toEqual(OWN)
    expect((await readGoogleAccount('me@gmail.com'))?.client).toEqual(OWN)
  })
})
