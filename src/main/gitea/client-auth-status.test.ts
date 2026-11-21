import { afterEach, describe, expect, it, vi } from 'vitest'
import { getGiteaAuthStatus } from './client'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('getGiteaAuthStatus', () => {
  it('returns null authError when Gitea is unconfigured or unauthenticated without token', async () => {
    vi.stubEnv('ORCA_GITEA_API_BASE_URL', '')
    vi.stubEnv('ORCA_GITEA_TOKEN', '')
    await expect(getGiteaAuthStatus()).resolves.toEqual({
      configured: false,
      authenticated: false,
      account: null,
      baseUrl: null,
      tokenConfigured: false,
      authError: null
    })

    vi.stubEnv('ORCA_GITEA_API_BASE_URL', 'https://git.example.com')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ version: '1.22.0' }, { status: 200 }))
    )
    await expect(getGiteaAuthStatus()).resolves.toEqual({
      configured: true,
      authenticated: false,
      account: null,
      baseUrl: 'https://git.example.com/api/v1',
      tokenConfigured: false,
      authError: null
    })
  })

  it('returns null authError when token authentication succeeds', async () => {
    vi.stubEnv('ORCA_GITEA_API_BASE_URL', 'https://git.example.com')
    vi.stubEnv('ORCA_GITEA_TOKEN', 'secret-token-value')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ login: 'gitea-user' }, { status: 200 }))
    )

    await expect(getGiteaAuthStatus()).resolves.toEqual({
      configured: true,
      authenticated: true,
      account: 'gitea-user',
      baseUrl: 'https://git.example.com/api/v1',
      tokenConfigured: true,
      authError: null
    })
  })

  it('surfaces sanitized Gitea API auth failure messages instead of collapsing to null', async () => {
    vi.stubEnv('ORCA_GITEA_API_BASE_URL', 'https://git.example.com')
    vi.stubEnv('ORCA_GITEA_TOKEN', 'secret-token-value')
    const message =
      'token does not have at least one of required scope(s), required=[read:user], token scope=write:package'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ message, url: 'https://git.example.com/api/swagger' }, { status: 403 })
      )
    )

    await expect(getGiteaAuthStatus()).resolves.toEqual({
      configured: true,
      authenticated: false,
      account: null,
      baseUrl: 'https://git.example.com/api/v1',
      tokenConfigured: true,
      authError: message
    })
  })
})
