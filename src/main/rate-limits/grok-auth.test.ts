import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsMocks = vi.hoisted(() => ({ readFile: vi.fn() }))

vi.mock('node:fs/promises', () => fsMocks)

import { readGrokAuthSession } from './grok-auth'

describe('readGrokAuthSession', () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('redacts filesystem paths from auth read failures', async () => {
    fsMocks.readFile.mockRejectedValueOnce(
      Object.assign(
        new Error('EACCES: permission denied, open /Users/brennanbenson/private/.grok/auth.json'),
        { code: 'EACCES' }
      )
    )

    expect(await readGrokAuthSession({ home: '/Users/brennanbenson/private/.grok' })).toEqual({
      status: 'error',
      error: 'Unable to read Grok auth file'
    })
  })

  it('reports a missing auth file as signed out', async () => {
    fsMocks.readFile.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))

    expect(await readGrokAuthSession({ home: '/tmp/missing-grok-home' })).toEqual({
      status: 'missing'
    })
  })

  it('treats a token-less auth file as signed out, not an error', async () => {
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({ 'https://auth.x.ai::client': { user_id: 'u1' } })
    )

    expect(await readGrokAuthSession({ home: '/tmp/tokenless-grok-home' })).toEqual({
      status: 'missing'
    })
  })

  it('reports malformed auth JSON without parser details', async () => {
    fsMocks.readFile.mockResolvedValueOnce('{')

    expect(await readGrokAuthSession({ home: '/tmp/malformed-grok-home' })).toEqual({
      status: 'error',
      error: 'Grok auth file is invalid'
    })
  })

  it.each(['https://auth.x.ai', 'https://auth.x.ai::client'])(
    'prefers the %s issuer entry over an earlier alternate issuer',
    async (preferredIssuer) => {
      fsMocks.readFile.mockResolvedValueOnce(
        JSON.stringify({
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
      )

      expect(
        await readGrokAuthSession({ home: `/tmp/preferred-${preferredIssuer.length}` })
      ).toEqual({
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

  it('falls back to the first tokenized entry when no auth.x.ai key exists', async () => {
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        'https://alternate.example.com::client': {
          key: 'alt-token',
          user_id: 'alt-user',
          email: 'alt@example.com',
          expires_at: '2099-01-01T00:00:00.000Z'
        }
      })
    )

    expect(await readGrokAuthSession({ home: '/tmp/alternate-grok-home' })).toEqual({
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

  it('skips an expired auth.x.ai client entry when a fresh one follows it', async () => {
    fsMocks.readFile.mockResolvedValueOnce(
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

    expect(await readGrokAuthSession({ home: '/tmp/fresh-grok-home' })).toMatchObject({
      status: 'ok',
      session: { accessToken: 'fresh-token' }
    })
  })

  it('does not resurrect an alternate issuer when an auth.x.ai entry is tokenless', async () => {
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        'https://alternate.example.com::client': { key: 'stale-token' },
        'https://auth.x.ai::client': { user_id: 'signed-out-user' }
      })
    )

    expect(await readGrokAuthSession({ home: '/tmp/signed-out-grok-home' })).toEqual({
      status: 'missing'
    })
  })

  it('reads auth.json from a resolved WSL UNC home', async () => {
    fsMocks.readFile.mockResolvedValueOnce('{}')

    await readGrokAuthSession({ home: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.grok' })

    expect(fsMocks.readFile).toHaveBeenCalledWith(
      '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.grok\\auth.json',
      'utf-8'
    )
  })

  it('fails closed when the WSL home cannot be resolved', async () => {
    expect(await readGrokAuthSession({ home: null })).toEqual({
      status: 'error',
      error: 'Unable to resolve Grok auth home'
    })
    expect(fsMocks.readFile).not.toHaveBeenCalled()
  })

  it('bounds a stalled auth read', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(
      AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError'))
    )

    expect(await readGrokAuthSession({ home: '/tmp/stalled-grok-home', timeoutMs: 1 })).toEqual({
      status: 'error',
      error: 'Unable to read Grok auth file'
    })
    expect(fsMocks.readFile).not.toHaveBeenCalled()
  })
})
