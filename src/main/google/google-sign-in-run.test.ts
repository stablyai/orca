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
const { googleAccountView } = await import('./google-connect')
const { googleAccountApp } = await import('../../shared/google/google-account-app')

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
async function signIn(
  signedInAs: string,
  loginHint?: string,
  { goneApps = [], currentApp = false }: { goneApps?: string[]; currentApp?: boolean } = {}
) {
  const used: { authorize?: string; exchange?: string } = {}
  const http: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const form = new URLSearchParams(String(init?.body))
      if (form.get('code') === 'orca-key-check') {
        const gone = goneApps.includes(form.get('client_id') ?? '')
        return Response.json({ error: gone ? 'invalid_client' : 'invalid_grant' }, { status: 400 })
      }
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
  }
  let returned: (query: string) => void = () => {}
  const record = await runGoogleSignIn(
    { http, now: () => 1_000, client: () => CURRENT },
    {
      callerLoopbackPort: 4567,
      choices: [],
      openBrowser: false,
      ...(loginHint ? { loginHint } : {}),
      ...(currentApp ? { currentApp } : {})
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

async function saveAccount(email: string): Promise<void> {
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
    connectedAt: 500
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
    // Its API links and admin requests name that app too, and the view never carries its secret.
    const view = googleAccountView(record)
    expect(googleAccountApp(view, CURRENT)).toEqual({
      clientId: 'own-id',
      projectId: 'own-project'
    })
    expect(JSON.stringify(view)).not.toContain('own-secret')
  })

  it('is this computer’s app for a saved account when a setup just made it', async () => {
    await saveAccount('me@gmail.com')
    const { record, used } = await signIn('me@gmail.com', 'me@gmail.com', { currentApp: true })
    expect(used).toEqual({ authorize: 'current-id', exchange: 'current-id' })
    expect(googleAccountApp(googleAccountView(record), CURRENT)).toEqual({
      clientId: 'current-id',
      projectId: 'current-project'
    })
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
    await saveAccount('me@gmail.com')
    const { used } = await signIn('me@gmail.com', 'me@gmail.com', { goneApps: ['own-id'] })
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

/** Signs in through the loopback return, with Google's token endpoint answering `token`. */
async function failedSignIn(token: () => Promise<Response>) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const http: typeof fetch = async (input) =>
    String(input).startsWith('https://oauth2.googleapis.com/token') ? token() : Response.json({})
  let page: Promise<string> = Promise.resolve('')
  const error = await runGoogleSignIn(
    { http, now: () => 1_000, client: () => CURRENT },
    { choices: [], openBrowser: false },
    {
      signal: new AbortController().signal,
      onPrompt: (prompt) => {
        const state = new URL(prompt.authorizeUrl).searchParams.get('state')
        page = fetch(`${prompt.redirectUri}?state=${state}&code=the-code`).then((r) => r.text())
      },
      nextCode: () => new Promise(() => {})
    }
  ).then(
    () => null,
    (failure: unknown) => (failure instanceof Error ? failure.message : String(failure))
  )
  const logged = warn.mock.calls.map((call) => String(call[0]))
  warn.mockRestore()
  return { error, page: await page, logged }
}

const tokens = (overrides: Record<string, unknown> = {}) =>
  Promise.resolve(
    Response.json({
      access_token: 'access',
      expires_in: 3600,
      refresh_token: 'refresh',
      scope: 'openid email',
      id_token: idToken('me@gmail.com'),
      ...overrides
    })
  )

describe('a Google sign-in that fails after Google returned', () => {
  it('says Orca couldn’t reach Google, in the tab too, when the exchange can’t connect', async () => {
    const { error, page, logged } = await failedSignIn(() =>
      Promise.reject(new TypeError('fetch failed'))
    )
    expect(error).toBe(
      'Orca couldn’t reach Google from this computer. Check your VPN, proxy or HTTPS inspection, then try again.'
    )
    expect(page).toContain('Orca couldn’t reach Google from this computer.')
    expect(logged).toEqual(['[google] sign-in failed at token exchange: network'])
  })

  it('names the client secret when Google rejects the app', async () => {
    const { error, logged } = await failedSignIn(() =>
      Promise.resolve(Response.json({ error: 'invalid_client' }, { status: 401 }))
    )
    expect(error).toBe(
      'Google rejected this app’s client secret. Download the client file again and import it in Orca.'
    )
    expect(logged).toEqual(['[google] sign-in failed at token exchange: invalid_client'])
  })

  it('asks to start again when Google already spent the sign-in', async () => {
    const { error, logged } = await failedSignIn(() =>
      Promise.resolve(Response.json({ error: 'invalid_grant' }, { status: 400 }))
    )
    expect(error).toBe(
      'Google says this sign-in was already used or has expired. Start again in Orca.'
    )
    expect(logged).toEqual(['[google] sign-in failed at token exchange: invalid_grant'])
  })

  it('says Google didn’t name the account when there is no id token', async () => {
    const { error, logged } = await failedSignIn(() => tokens({ id_token: undefined }))
    expect(error).toBe('Google didn’t say which account signed in. Try again.')
    expect(logged).toEqual(['[google] sign-in failed at account: no_account'])
  })

  it('says the sign-in won’t last when there is no refresh token', async () => {
    const { error, logged } = await failedSignIn(() => tokens({ refresh_token: undefined }))
    expect(error).toBe('Google didn’t return a lasting sign-in. Try again.')
    expect(logged).toEqual(['[google] sign-in failed at account: no_refresh_token'])
  })

  it('says the account couldn’t be saved when writing it fails', async () => {
    // A folder where the account's file goes: reading it finds nothing, writing it fails.
    const file = join(
      home.dir,
      '.orca',
      'google',
      'accounts',
      `${Buffer.from('me@gmail.com').toString('base64url')}.enc`
    )
    mkdirSync(file, { recursive: true })
    writeFileSync(join(file, 'keep'), 'x')
    const { error, logged } = await failedSignIn(() => tokens())
    expect(error).toBe('Orca couldn’t save the Google account on this computer. Try again.')
    expect(logged).toEqual(['[google] sign-in failed at save: save_failed'])
  })
})
