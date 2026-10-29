import { describe, expect, it } from 'vitest'
import { parseGrokAuthSession } from './grok-auth'

describe('parseGrokAuthSession', () => {
  it('treats a token-less auth file as signed out', () => {
    expect(
      parseGrokAuthSession(JSON.stringify({ 'https://auth.x.ai::client': { user_id: 'u1' } }))
    ).toEqual({ status: 'missing' })
  })

  it('reports malformed auth JSON without parser details', () => {
    expect(parseGrokAuthSession('{')).toEqual({
      status: 'error',
      error: 'Grok auth file is invalid'
    })
  })

  it.each(['https://auth.x.ai', 'https://auth.x.ai::client'])(
    'prefers the %s issuer entry over an earlier alternate issuer',
    (preferredIssuer) => {
      const result = parseGrokAuthSession(
        JSON.stringify({
          'https://stale.example.com::client': {
            key: 'stale-token',
            user_id: 'stale-user',
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
      )

      expect(result).toMatchObject({
        status: 'ok',
        session: { accessToken: 'live-token', userId: 'live-user', email: 'live@example.com' }
      })
    }
  )

  it('falls back to the first tokenized entry when no auth.x.ai key exists', () => {
    const result = parseGrokAuthSession(
      JSON.stringify({
        'https://alternate.example.com::client': {
          key: 'alt-token',
          user_id: 'alt-user',
          expires_at: '2099-01-01T00:00:00.000Z'
        }
      })
    )
    expect(result).toMatchObject({ status: 'ok', session: { accessToken: 'alt-token' } })
  })

  it('skips an expired preferred entry when a fresh one follows it', () => {
    const result = parseGrokAuthSession(
      JSON.stringify({
        'https://auth.x.ai::old-client': {
          key: 'expired-token',
          expires_at: '2020-01-01T00:00:00.000Z'
        },
        'https://auth.x.ai::current-client': {
          key: 'fresh-token',
          expires_at: '2099-01-01T00:00:00.000Z'
        }
      })
    )
    expect(result).toMatchObject({ status: 'ok', session: { accessToken: 'fresh-token' } })
  })

  it('does not resurrect an alternate issuer after tokenless preferred logout', () => {
    const result = parseGrokAuthSession(
      JSON.stringify({
        'https://alternate.example.com::client': { key: 'stale-token' },
        'https://auth.x.ai::client': { user_id: 'signed-out-user' }
      })
    )
    expect(result).toEqual({ status: 'missing' })
  })
})
