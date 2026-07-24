import type * as NodeFs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authFile = vi.hoisted<{ contents: string | null; error: Error | null }>(() => ({
  contents: null,
  error: null
}))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  existsSync: vi.fn(() => authFile.contents !== null || authFile.error !== null)
}))

vi.mock('../integration-credential-file', () => ({
  readIntegrationCredentialFileSyncText: vi.fn(() => {
    if (authFile.error) {
      throw authFile.error
    }
    if (authFile.contents === null) {
      throw new Error('Auth file is missing')
    }
    return authFile.contents
  })
}))

import { readGrokAuthSession } from './grok-auth'

describe('readGrokAuthSession', () => {
  beforeEach(() => {
    authFile.contents = null
    authFile.error = null
  })

  it('redacts filesystem paths from auth read failures', () => {
    authFile.error = new Error(
      'EACCES: permission denied, open /Users/brennanbenson/private/.grok/auth.json'
    )

    expect(readGrokAuthSession()).toEqual({
      status: 'error',
      error: 'Unable to read Grok auth file'
    })
  })

  it('treats a token-less auth file as signed out, not an error', () => {
    authFile.contents = JSON.stringify({
      'https://auth.x.ai::client': { user_id: 'u1' }
    })

    expect(readGrokAuthSession()).toEqual({ status: 'missing' })
  })

  it('reports malformed auth JSON without parser details', () => {
    authFile.contents = '{'

    expect(readGrokAuthSession()).toEqual({
      status: 'error',
      error: 'Grok auth file is invalid'
    })
  })

  it.each(['https://auth.x.ai', 'https://auth.x.ai::client'])(
    'prefers the %s issuer entry over an earlier alternate issuer',
    (preferredIssuer) => {
      authFile.contents = JSON.stringify({
        'https://stale.example.com::client': {
          key: 'stale-token',
          user_id: 'stale-user',
          email: 'stale@example.com',
          expires_at: '2099-01-01T00:00:00.000Z'
        },
        [preferredIssuer]: {
          key: 'live-token',
          user_id: 'live-user',
          email: 'live@example.com',
          team_id: 'team-1',
          expires_at: '2099-06-01T00:00:00.000Z',
          oidc_client_id: 'client-1'
        }
      })

      expect(readGrokAuthSession()).toEqual({
        status: 'ok',
        session: {
          accessToken: 'live-token',
          userId: 'live-user',
          email: 'live@example.com',
          teamId: 'team-1',
          expiresAtMs: Date.parse('2099-06-01T00:00:00.000Z'),
          oidcClientId: 'client-1'
        }
      })
    }
  )

  it('falls back to the first tokenized entry when no auth.x.ai key exists', () => {
    authFile.contents = JSON.stringify({
      'https://alternate.example.com::client': {
        key: 'alt-token',
        user_id: 'alt-user',
        email: 'alt@example.com',
        expires_at: '2099-01-01T00:00:00.000Z'
      }
    })

    expect(readGrokAuthSession()).toEqual({
      status: 'ok',
      session: {
        accessToken: 'alt-token',
        userId: 'alt-user',
        email: 'alt@example.com',
        teamId: null,
        expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
        oidcClientId: null
      }
    })
  })

  it('skips an expired auth.x.ai client entry when a fresh one follows it', () => {
    authFile.contents = JSON.stringify({
      'https://auth.x.ai::old-client': {
        key: 'expired-token',
        expires_at: '2020-01-01T00:00:00.000Z'
      },
      'https://auth.x.ai::current-client': {
        key: 'fresh-token',
        expires_at: '2099-01-01T00:00:00.000Z'
      }
    })

    expect(readGrokAuthSession()).toMatchObject({
      status: 'ok',
      session: { accessToken: 'fresh-token' }
    })
  })

  it('does not resurrect an alternate issuer when an auth.x.ai entry is tokenless', () => {
    authFile.contents = JSON.stringify({
      'https://alternate.example.com::client': { key: 'stale-token' },
      'https://auth.x.ai::client': { user_id: 'signed-out-user' }
    })

    expect(readGrokAuthSession()).toEqual({ status: 'missing' })
  })
})
