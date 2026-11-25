import { mkdtempSync, rmSync } from 'node:fs'
import type * as os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GOOGLE_SERVICE_INFO } from '../../shared/google/google-scopes'

const home = vi.hoisted(() => ({ dir: '' }))
vi.mock('node:os', async (actual) => ({
  ...(await actual<typeof os>()),
  homedir: () => home.dir
}))

const { readGoogleAccount, saveGoogleAccount } = await import('./google-credential-store')
const { refreshGoogleAccount } = await import('./google-account-tokens')
const { GoogleConnect, googleAccountView } = await import('./google-connect')

const NOW = 1_800_000_000_000
const EMAIL = 'work@acme.com'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

const OLD_RECORD = {
  email: EMAIL,
  client: { clientId: 'id', clientSecret: 'secret' },
  refreshToken: 'refresh',
  accessToken: 'access',
  expiresAt: NOW + 3_600_000,
  grantedScopes: [...GOOGLE_SERVICE_INFO.gmail.scopes],
  choices: ['gmail' as const],
  status: 'connected' as const,
  services: [],
  connectedAt: NOW - 1_000
}

const refresh = (answer: () => Response) =>
  refreshGoogleAccount(EMAIL, { now: () => NOW, http: async () => answer() }, true)

beforeEach(async () => {
  home.dir = mkdtempSync(join(tmpdir(), 'google-access-ended-'))
  await saveGoogleAccount(OLD_RECORD)
})

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true })
})

describe('a Google account whose access ended', () => {
  it('reads a record saved before Google errors were kept unchanged', async () => {
    expect(await readGoogleAccount(EMAIL)).toEqual(OLD_RECORD)
  })

  it("keeps Google's own error and shows it after Orca's sentence", async () => {
    await refresh(() =>
      json(400, {
        error: 'invalid_grant',
        error_subtype: 'invalid_rapt',
        error_description: 'reauth related error (invalid_rapt)'
      })
    )
    const record = await readGoogleAccount(EMAIL)
    expect(record).toMatchObject({
      status: 'reconnect',
      refreshToken: null,
      googleError: {
        error: 'invalid_grant',
        subtype: 'invalid_rapt',
        description: 'reauth related error (invalid_rapt)'
      }
    })
    const view = googleAccountView(record!)
    expect(view.reason).toBe('Google access ended (revoked, expired, or the password changed).')
    expect(view.googleError).toBe(
      'reauth related error (invalid_rapt) (invalid_grant, invalid_rapt)'
    )
  })

  it.each(['admin_policy_enforced', 'deleted_client', 'org_internal'])(
    'ends access on Google refusing with %s',
    async (error) => {
      await refresh(() => json(400, { error }))
      expect(await readGoogleAccount(EMAIL)).toMatchObject({
        status: 'reconnect',
        googleError: { error }
      })
    }
  )

  it('stays connected through a Google outage, a rate limit or an unknown request error', async () => {
    for (const answer of [
      () => json(503, { error: 'backendError' }),
      () => json(429, { error: 'rate_limit_exceeded' }),
      () => json(400, { error: 'invalid_request' })
    ]) {
      await refresh(answer)
      expect(await readGoogleAccount(EMAIL)).toEqual(OLD_RECORD)
    }
  })

  it('stays Reconnect when Google ends the grant while a check probes its services', async () => {
    let ended = false
    const connect = new GoogleConnect({
      now: () => NOW,
      http: async (input) => {
        if (String(input) !== TOKEN_URL && !ended) {
          ended = true
          await refresh(() => json(400, { error: 'invalid_grant' }))
        }
        return json(200, {})
      }
    })
    const [view] = await connect.checkAccounts()
    expect(view?.status).toBe('reconnect')
    expect((await readGoogleAccount(EMAIL))?.status).toBe('reconnect')
  })
})
