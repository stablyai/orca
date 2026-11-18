import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import * as realOs from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoogleSignInStatus } from '../../shared/google/google-connect-types'
import { GOOGLE_SERVICE_CHOICES, googleSignInScopes } from '../../shared/google/google-scopes'

const GOOGLE_SIGN_IN_SCOPES = googleSignInScopes(GOOGLE_SERVICE_CHOICES)

const CLIENT_FILE = JSON.stringify({
  installed: {
    client_id: '123-abc.apps.googleusercontent.com',
    project_id: 'acme-orca',
    client_secret: 'GOCSPX-secret',
    // Never used: Orca calls Google's own endpoints whatever a file says.
    token_uri: 'https://attacker.example/token'
  }
})

let tempHome = ''
let now = 1_800_000_000_000

type Refresh = 'ok' | 'invalid_grant' | 'offline'
type FakeGoogle = {
  http: typeof fetch
  calls: { url: string; form: URLSearchParams | null }[]
  challenge: string | null
  refresh: Refresh
  grantedScope: string
}

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'RS256' })}.${part(claims)}.sig`
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function fakeGoogle(): FakeGoogle {
  const google: FakeGoogle = {
    calls: [],
    challenge: null,
    refresh: 'ok',
    grantedScope: GOOGLE_SIGN_IN_SCOPES.join(' '),
    http: async (input, init) => {
      const url = String(input)
      const form = typeof init?.body === 'string' ? new URLSearchParams(init.body) : null
      google.calls.push({ url, form })
      if (url === 'https://oauth2.googleapis.com/token') {
        expect(form?.get('client_secret')).toBe('GOCSPX-secret')
        if (form?.get('grant_type') === 'authorization_code') {
          const verifier = form.get('code_verifier') ?? ''
          const s256 = createHash('sha256').update(verifier).digest('base64url')
          if (form.get('code') !== 'code-1' || s256 !== google.challenge) {
            return json(400, { error: 'invalid_grant' })
          }
          return json(200, {
            access_token: 'at-1',
            expires_in: 3600,
            refresh_token: 'rt-1',
            scope: google.grantedScope,
            id_token: idToken({ sub: '1044', email: 'Ada@Acme.dev', email_verified: true })
          })
        }
        if (google.refresh === 'offline') {
          throw new TypeError('fetch failed')
        }
        if (google.refresh === 'invalid_grant') {
          return json(400, {
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.'
          })
        }
        return json(200, { access_token: 'at-2', expires_in: 3600, scope: google.grantedScope })
      }
      if (url.startsWith('https://oauth2.googleapis.com/revoke')) {
        return json(200, {})
      }
      if (url.startsWith('https://www.googleapis.com/calendar/')) {
        return json(403, {
          error: {
            code: 403,
            message:
              'Google Calendar API has not been used in project 42 before or it is disabled.',
            status: 'PERMISSION_DENIED',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'SERVICE_DISABLED',
                metadata: {
                  activationUrl:
                    'https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=42'
                }
              }
            ]
          }
        })
      }
      if (url.includes('orca-readiness-check')) {
        return json(404, { error: { code: 404, message: 'Requested entity was not found.' } })
      }
      return json(200, {})
    }
  }
  return google
}

async function load() {
  vi.resetModules()
  const { setSecretStore } = await import('../../shared/secure-storage/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`sealed:${value}`),
    decryptString: (value) => {
      const text = value.toString('utf-8')
      if (!text.startsWith('sealed:')) {
        throw new Error('Keychain access denied')
      }
      return text.slice('sealed:'.length)
    },
    describeProtectionGap: () => null
  })
  vi.doMock('node:os', () => ({ ...realOs, homedir: () => tempHome }))
  vi.doMock('os', () => ({ ...realOs, homedir: () => tempHome }))
  return {
    ...(await import('./google-connect')),
    tokens: await import('./google-account-tokens'),
    store: await import('./google-credential-store')
  }
}

async function until(
  connect: { waitSignIn: (o: string, f: string, r: number) => Promise<GoogleSignInStatus> },
  flow: GoogleSignInStatus,
  done: (status: GoogleSignInStatus) => boolean
): Promise<GoogleSignInStatus> {
  let status = flow
  while (!done(status)) {
    status = await connect.waitSignIn('owner', flow.flowId, status.revision)
  }
  return status
}

const waiting = (status: GoogleSignInStatus) => status.phase !== 'starting'
const settled = (status: GoogleSignInStatus) =>
  status.phase === 'signedIn' || status.phase === 'failed' || status.phase === 'cancelled'

function challengeOf(status: GoogleSignInStatus): string {
  return new URL(status.prompt?.authorizeUrl ?? '').searchParams.get('code_challenge') ?? ''
}

function returnUrl(status: GoogleSignInStatus, overrides: Record<string, string> = {}): string {
  const prompt = status.prompt
  if (!prompt) {
    throw new Error('no prompt')
  }
  const url = new URL(prompt.redirectUri)
  url.searchParams.set('state', new URL(prompt.authorizeUrl).searchParams.get('state') ?? '')
  url.searchParams.set('code', 'code-1')
  for (const [key, value] of Object.entries(overrides)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

beforeEach(() => {
  tempHome = mkdtempSync(join(realOs.tmpdir(), 'orca-google-'))
  now = 1_800_000_000_000
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tempHome, { recursive: true, force: true })
})

describe('Google sign-in on the execution host', () => {
  it('needs a client first', async () => {
    const { GoogleConnect } = await load()
    const connect = new GoogleConnect({ http: fakeGoogle().http, now: () => now })
    const flow = connect.startSignIn('owner', { openBrowser: false })
    const done = await until(connect, flow, settled)
    expect(done.phase).toBe('failed')
    expect(done.error).toContain('Add your team’s Google client first, in Orca')
  })

  it('signs in through this host’s loopback with PKCE and state, and keeps the grant encrypted here', async () => {
    const { GoogleConnect, store } = await load()
    const google = fakeGoogle()
    const opened: string[] = []
    const connect = new GoogleConnect({
      http: google.http,
      now: () => now,
      openBrowser: async (url) => {
        opened.push(url)
      }
    })
    connect.importClient(CLIENT_FILE)
    const prompt = await until(
      connect,
      connect.startSignIn('owner', { openBrowser: true }),
      waiting
    )
    const authorize = new URL(prompt.prompt?.authorizeUrl ?? '')
    expect(authorize.origin + authorize.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth'
    )
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('access_type')).toBe('offline')
    expect(authorize.searchParams.get('scope')).toBe(GOOGLE_SIGN_IN_SCOPES.join(' '))
    expect(prompt.prompt?.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/google\/callback$/)
    expect(prompt.prompt?.browserOpened).toBe(true)
    expect(opened).toEqual([prompt.prompt?.authorizeUrl])
    google.challenge = challengeOf(prompt)

    // A stray probe with another state leaves the sign-in waiting.
    const stray = await fetch(returnUrl(prompt, { state: 'someone-else' }))
    expect(stray.status).toBe(400)
    const back = await fetch(returnUrl(prompt))
    expect(back.status).toBe(200)
    // The tab waited for the saved account before saying so.
    expect(await back.text()).toContain('Signed in to Google')
    expect(store.readGoogleAccount('ada@acme.dev')).not.toBeNull()

    const done = await until(connect, prompt, settled)
    expect(done.phase).toBe('signedIn')
    expect(done.account).toMatchObject({ email: 'ada@acme.dev', status: 'connected' })
    const services = Object.fromEntries(
      (done.account?.services ?? []).map((service) => [service.service, service])
    )
    expect(services.gmail?.state).toBe('ready')
    expect(services.docs?.state).toBe('ready')
    expect(services.calendar).toMatchObject({
      state: 'api-disabled',
      enableUrl:
        'https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=42'
    })
    // The token URL in the client file is ignored.
    expect(google.calls.some((call) => call.url.includes('attacker'))).toBe(false)

    const saved = store.readGoogleAccount('ada@acme.dev')
    expect(saved).toMatchObject({ sub: '1044', refreshToken: 'rt-1', accessToken: 'at-1' })
    const files = readdirSync(join(tempHome, '.orca', 'google', 'accounts'))
    expect(files).toHaveLength(1)
  })

  it('never tells the browser tab "Signed in" when the host fails to finish', async () => {
    const { GoogleConnect } = await load()
    // No challenge recorded: Google refuses the code exchange.
    const connect = new GoogleConnect({ http: fakeGoogle().http, now: () => now })
    connect.importClient(CLIENT_FILE)
    const prompt = await until(
      connect,
      connect.startSignIn('owner', { openBrowser: false }),
      waiting
    )
    const back = await fetch(returnUrl(prompt))
    const page = await back.text()
    expect(page).not.toContain('Signed in')
    expect(page).toContain('Couldn’t sign in to Google')
    expect((await until(connect, prompt, settled)).phase).toBe('failed')
  })

  it('leaves the local sign-in waiting on a malformed return with its state', async () => {
    const { GoogleConnect } = await load()
    const google = fakeGoogle()
    const connect = new GoogleConnect({ http: google.http, now: () => now })
    connect.importClient(CLIENT_FILE)
    const prompt = await until(
      connect,
      connect.startSignIn('owner', { openBrowser: false }),
      waiting
    )
    google.challenge = challengeOf(prompt)
    expect((await fetch(`${returnUrl(prompt)}&code=code-2`)).status).toBe(400)
    expect((await fetch(returnUrl(prompt).replace(/&code=[^&]*/, ''))).status).toBe(400)
    expect(await (await fetch(returnUrl(prompt))).text()).toContain('Signed in to Google')
    expect((await until(connect, prompt, settled)).phase).toBe('signedIn')
  })

  it('takes a pasted address only for the sign-in this host started, and not a wrong one', async () => {
    const { GoogleConnect } = await load()
    const google = fakeGoogle()
    const connect = new GoogleConnect({ http: google.http, now: () => now })
    connect.importClient(CLIENT_FILE)
    const prompt = await until(
      connect,
      connect.startSignIn('owner', { openBrowser: false }),
      waiting
    )
    expect(prompt.prompt?.browserOpened).toBe(false)
    google.challenge = challengeOf(prompt)

    expect(() =>
      connect.finishSignIn('owner', prompt.flowId, returnUrl(prompt, { state: 'phished' }))
    ).toThrow("isn't from the Google sign-in Orca just started")
    const otherPort = returnUrl(prompt).replace(/127\.0\.0\.1:\d+/, '127.0.0.1:1')
    expect(() => connect.finishSignIn('owner', prompt.flowId, otherPort)).toThrow(
      "isn't from the Google sign-in"
    )
    expect(() => connect.finishSignIn('owner', prompt.flowId, 'not a url')).toThrow()
    expect(() =>
      connect.finishSignIn('owner', prompt.flowId, `${returnUrl(prompt)}&state=phished`)
    ).toThrow("isn't from the Google sign-in")
    // Another client can't answer it.
    expect(() => connect.finishSignIn('intruder', prompt.flowId, returnUrl(prompt))).toThrow(
      'no longer active'
    )

    // The refusals spent nothing; the right address still finishes it.
    connect.finishSignIn('owner', prompt.flowId, returnUrl(prompt))
    const done = await until(connect, prompt, settled)
    expect(done.phase).toBe('signedIn')
  })

  it('stops taking a pasted address once the sign-in is a few minutes old', async () => {
    const { GoogleConnect } = await load()
    const connect = new GoogleConnect({ http: fakeGoogle().http, now: () => now })
    connect.importClient(CLIENT_FILE)
    const prompt = await until(
      connect,
      connect.startSignIn('owner', { openBrowser: false }),
      waiting
    )
    now += 6 * 60_000
    expect(() => connect.finishSignIn('owner', prompt.flowId, returnUrl(prompt))).toThrow(
      'No Google sign-in is waiting'
    )
    await connect.cancelSignIn('owner', prompt.flowId)
  })

  it('says when Google refused the sign-in', async () => {
    const { GoogleConnect } = await load()
    const connect = new GoogleConnect({ http: fakeGoogle().http, now: () => now })
    connect.importClient(CLIENT_FILE)
    const prompt = await until(
      connect,
      connect.startSignIn('owner', { openBrowser: false }),
      waiting
    )
    expect(() =>
      connect.finishSignIn(
        'owner',
        prompt.flowId,
        returnUrl(prompt, { error: 'admin_policy_enforced' })
      )
    ).toThrow("company's Google admin blocked this app")
    await connect.cancelSignIn('owner', prompt.flowId)
  })

  it('lets a paired desktop own the browser return: its port in the link, its relayed address', async () => {
    const { GoogleConnect } = await load()
    const google = fakeGoogle()
    const connect = new GoogleConnect({ http: google.http, now: () => now })
    connect.importClient(CLIENT_FILE)
    const prompt = await until(
      connect,
      connect.startSignIn('owner', { openBrowser: false, callerLoopbackPort: 45_678 }),
      waiting
    )
    expect(prompt.prompt?.redirectUri).toBe('http://127.0.0.1:45678/google/callback')
    google.challenge = challengeOf(prompt)
    connect.finishSignIn('owner', prompt.flowId, returnUrl(prompt))
    const done = await until(connect, prompt, settled)
    expect(done.account?.email).toBe('ada@acme.dev')
    const exchange = google.calls.find(
      (call) => call.form?.get('grant_type') === 'authorization_code'
    )
    expect(exchange?.form?.get('redirect_uri')).toBe('http://127.0.0.1:45678/google/callback')
  })

  it('asks only for the picked services plus name lookup, and adding one later asks for the union', async () => {
    const { GoogleConnect } = await load()
    const google = fakeGoogle()
    google.grantedScope = googleSignInScopes(['gmail']).join(' ')
    const connect = new GoogleConnect({ http: google.http, now: () => now })
    connect.importClient(CLIENT_FILE)
    const first = await until(
      connect,
      connect.startSignIn('owner', { openBrowser: false, services: ['gmail'] }),
      waiting
    )
    const asked = new URL(first.prompt?.authorizeUrl ?? '').searchParams
    expect(asked.get('scope')?.split(' ')).toEqual([
      'openid',
      'email',
      'https://www.googleapis.com/auth/contacts.readonly',
      'https://www.googleapis.com/auth/contacts.other.readonly',
      'https://www.googleapis.com/auth/directory.readonly',
      'https://www.googleapis.com/auth/gmail.modify'
    ])
    expect(asked.get('include_granted_scopes')).toBe('true')
    google.challenge = challengeOf(first)
    connect.finishSignIn('owner', first.flowId, returnUrl(first))
    const done = await until(connect, first, settled)
    expect(done.account?.services.map((service) => service.service)).toEqual(['gmail', 'contacts'])
    expect(google.calls.some((call) => call.url.includes('calendar'))).toBe(false)

    google.grantedScope = googleSignInScopes(['gmail', 'files']).join(' ')
    const more = await until(
      connect,
      connect.startSignIn('owner', {
        openBrowser: false,
        loginHint: 'ada@acme.dev',
        services: ['files']
      }),
      waiting
    )
    const scopes = new URL(more.prompt?.authorizeUrl ?? '').searchParams.get('scope') ?? ''
    expect(scopes).toContain('gmail.modify')
    expect(scopes).toContain('/drive')
    expect(scopes).not.toContain('calendar')
    google.challenge = challengeOf(more)
    connect.finishSignIn('owner', more.flowId, returnUrl(more))
    const added = await until(connect, more, settled)
    expect(added.account?.services.map((service) => service.service)).toEqual([
      'gmail',
      'drive',
      'docs',
      'sheets',
      'contacts'
    ])
  })

  it('marks a service Needs permission when its scope was unticked, without calling it', async () => {
    const { GoogleConnect } = await load()
    const google = fakeGoogle()
    google.grantedScope = GOOGLE_SIGN_IN_SCOPES.filter((scope) => !scope.endsWith('/drive')).join(
      ' '
    )
    const connect = new GoogleConnect({ http: google.http, now: () => now })
    connect.importClient(CLIENT_FILE)
    const prompt = await until(
      connect,
      connect.startSignIn('owner', { openBrowser: false }),
      waiting
    )
    google.challenge = challengeOf(prompt)
    connect.finishSignIn('owner', prompt.flowId, returnUrl(prompt))
    const done = await until(connect, prompt, settled)
    const drive = done.account?.services.find((service) => service.service === 'drive')
    expect(drive?.state).toBe('needs-permission')
    expect(google.calls.some((call) => call.url.includes('drive/v3'))).toBe(false)
  })
})

describe('an account file this computer can’t read', () => {
  it('shows as Reconnect without hiding the others, and a new sign-in replaces it', async () => {
    const { GoogleConnect } = await load()
    const google = fakeGoogle()
    const connect = new GoogleConnect({ http: google.http, now: () => now })
    connect.importClient(CLIENT_FILE)
    const dir = join(tempHome, '.orca', 'google', 'accounts')
    mkdirSync(dir, { recursive: true })
    const name = `${Buffer.from('ada@acme.dev').toString('base64url')}.enc`
    writeFileSync(join(dir, name), Buffer.from([0x00, 0x01, 0xff, 0x7f]))

    expect(connect.accounts()).toEqual([
      expect.objectContaining({ email: 'ada@acme.dev', status: 'reconnect' })
    ])
    await expect(connect.checkAccounts()).resolves.toHaveLength(1)

    const prompt = await until(
      connect,
      connect.startSignIn('owner', { openBrowser: false, loginHint: 'ada@acme.dev' }),
      waiting
    )
    google.challenge = challengeOf(prompt)
    connect.finishSignIn('owner', prompt.flowId, returnUrl(prompt))
    expect((await until(connect, prompt, settled)).phase).toBe('signedIn')
    expect(connect.accounts()).toEqual([
      expect.objectContaining({ email: 'ada@acme.dev', status: 'connected' })
    ])
  })

  it('can still be disconnected', async () => {
    const { GoogleConnect } = await load()
    const connect = new GoogleConnect({ http: fakeGoogle().http, now: () => now })
    const dir = join(tempHome, '.orca', 'google', 'accounts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${Buffer.from('ada@acme.dev').toString('base64url')}.enc`),
      Buffer.from([0x00, 0x01])
    )
    expect(await connect.disconnect('ada@acme.dev', true)).toEqual({
      removed: 'ada@acme.dev',
      revoked: false
    })
    expect(connect.accounts()).toEqual([])
  })
})

describe('a refresh racing a disconnect or a reconnect', () => {
  it('never brings a disconnected account back', async () => {
    const loaded = await load()
    const google = fakeGoogle()
    const connect = new loaded.GoogleConnect({ http: google.http, now: () => now })
    connect.importClient(CLIENT_FILE)
    const prompt = await until(
      connect,
      connect.startSignIn('owner', { openBrowser: false }),
      waiting
    )
    google.challenge = challengeOf(prompt)
    connect.finishSignIn('owner', prompt.flowId, returnUrl(prompt))
    await until(connect, prompt, settled)
    now += 2 * 60 * 60_000
    const http: typeof fetch = async (input, init) => {
      await connect.disconnect('ada@acme.dev', false)
      return google.http(input, init)
    }
    await expect(
      loaded.tokens.googleAccessToken('ada@acme.dev', { http, now: () => now })
    ).rejects.toThrow("isn't connected")
    expect(connect.accounts()).toEqual([])
  })
})

describe('handing the client to teammates', () => {
  it('exports the client as a Desktop app file another computer imports as is', async () => {
    const { GoogleConnect } = await load()
    const connect = new GoogleConnect({ http: fakeGoogle().http, now: () => now })
    expect(() => connect.exportClient()).toThrow('no Google client')
    const imported = connect.importClient(CLIENT_FILE)
    const file = connect.exportClient()
    expect(file).not.toContain('attacker')
    expect(connect.importClient(file)).toEqual(imported)
  })
})

describe('keeping a Google sign-in fresh on the host', () => {
  async function connected() {
    const loaded = await load()
    const google = fakeGoogle()
    const connect = new loaded.GoogleConnect({ http: google.http, now: () => now })
    connect.importClient(CLIENT_FILE)
    const prompt = await until(
      connect,
      connect.startSignIn('owner', { openBrowser: false }),
      waiting
    )
    google.challenge = challengeOf(prompt)
    connect.finishSignIn('owner', prompt.flowId, returnUrl(prompt))
    await until(connect, prompt, settled)
    google.calls.length = 0
    return { ...loaded, google, connect, deps: { http: google.http, now: () => now } }
  }

  it('uses the saved token until it is near its end, then refreshes once for concurrent callers', async () => {
    const { tokens, google, deps } = await connected()
    expect(await tokens.googleAccessToken('ada@acme.dev', deps)).toBe('at-1')
    expect(google.calls).toHaveLength(0)
    now += 58 * 60_000
    const [a, b] = await Promise.all([
      tokens.googleAccessToken('ada@acme.dev', deps),
      tokens.googleAccessToken('Ada@acme.dev', deps)
    ])
    expect([a, b]).toEqual(['at-2', 'at-2'])
    const refreshes = google.calls.filter(
      (call) => call.form?.get('grant_type') === 'refresh_token'
    )
    expect(refreshes).toHaveLength(1)
    expect(refreshes[0]?.form?.get('refresh_token')).toBe('rt-1')
  })

  it('moves a revoked or expired grant to Reconnect and keeps the account listed', async () => {
    const { tokens, google, deps, connect } = await connected()
    google.refresh = 'invalid_grant'
    now += 2 * 60 * 60_000
    await expect(tokens.googleAccessToken('ada@acme.dev', deps)).rejects.toThrow(
      'Reconnect it in Orca.'
    )
    expect(connect.accounts()).toEqual([
      expect.objectContaining({ email: 'ada@acme.dev', status: 'reconnect' })
    ])
    // Reconnect state needs no more calls to Google.
    google.calls.length = 0
    await expect(tokens.googleAccessToken('ada@acme.dev', deps)).rejects.toThrow()
    expect(google.calls).toHaveLength(0)
  })

  it('keeps the account connected when Google is unreachable', async () => {
    const { tokens, google, deps, connect } = await connected()
    google.refresh = 'offline'
    now += 2 * 60 * 60_000
    await expect(tokens.googleAccessToken('ada@acme.dev', deps)).rejects.toThrow(
      "Couldn't reach Google"
    )
    expect(connect.accounts()[0]?.status).toBe('connected')
  })

  it('disconnect removes the sign-in here, and --revoke cancels it at Google too', async () => {
    const { google, connect } = await connected()
    expect(await connect.disconnect('ada@acme.dev', true)).toEqual({
      removed: 'ada@acme.dev',
      revoked: true
    })
    const revoke = google.calls.find((call) => call.url.includes('/revoke'))
    expect(revoke?.form?.get('token')).toBe('rt-1')
    expect(connect.accounts()).toEqual([])
    await expect(connect.disconnect('ada@acme.dev', false)).rejects.toThrow("isn't connected")
  })
})

describe('checking the saved app key', () => {
  it('remembers a clear answer for this key only, and keeps it over an unclear one', async () => {
    const { GoogleConnect } = await load()
    const answers: unknown[] = [
      { error: 'invalid_grant' },
      { error: 'rate_limited' },
      { error: 'invalid_client' }
    ]
    const http: typeof fetch = async () => json(400, answers.shift())
    const connect = new GoogleConnect({ http, now: () => now })
    expect(await connect.checkClient()).toBeNull()
    connect.importClient(CLIENT_FILE)
    expect(connect.clientCheck()).toBeNull()
    expect(await connect.checkClient()).toBe('works')
    expect(await connect.checkClient()).toBe('unknown')
    expect(connect.clientCheck()).toBe('works')
    // A new import is a new key: the old answer doesn't carry over.
    now += 1
    connect.importClient(CLIENT_FILE)
    expect(connect.clientCheck()).toBeNull()
    expect(await connect.checkClient()).toBe('gone')
    expect(connect.clientCheck()).toBe('gone')
  })
})
