import { describe, expect, it, vi } from 'vitest'
import type { KimiCredentialLocation } from './kimi-credential-location'
import {
  refreshKimiCredentials,
  type KimiCredentials,
  type KimiRefreshDependencies
} from './kimi-oauth-refresh'

const location: KimiCredentialLocation = {
  home: '/kimi-home',
  oauthHost: 'https://auth.example.com',
  baseUrl: 'https://api.example.com/coding/v1',
  storageName: 'kimi-code-env-test',
  credentialsPath: '/kimi-home/credentials/kimi-code-env-test.json',
  lockTarget: '/kimi-home/oauth/kimi-code-env-test',
  tokenUrl: 'https://auth.example.com/api/oauth/token',
  usageUrl: 'https://api.example.com/coding/v1/usages'
}

function expired(refreshToken: string): KimiCredentials {
  return { access_token: 'expired-access', refresh_token: refreshToken, expires_at: 1 }
}

describe('refreshKimiCredentials', () => {
  it('serializes overlapping refreshes and rereads the rotated winner after locking', async () => {
    let stored = expired('initial-refresh')
    let lockTail = Promise.resolve()
    const fetchToken = vi.fn(async (_url: string, init: RequestInit) => {
      const body = new URLSearchParams(init.body as string)
      expect(body.get('refresh_token')).toBe('initial-refresh')
      await Promise.resolve()
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'winner-access',
          refresh_token: 'winner-refresh',
          expires_in: 900
        })
      } as Response
    })
    const dependencies: KimiRefreshDependencies = {
      acquireLock: async (_target, action) => {
        const previous = lockTail
        let release!: () => void
        lockTail = new Promise<void>((resolve) => {
          release = resolve
        })
        await previous
        try {
          return await action()
        } finally {
          release()
        }
      },
      readCredentials: () => stored,
      saveCredentials: (_path, credentials) => {
        stored = credentials
      },
      fetchToken,
      nowSeconds: () => 100
    }

    const [first, second] = await Promise.all([
      refreshKimiCredentials(expired('initial-refresh'), location, dependencies),
      refreshKimiCredentials(expired('initial-refresh'), location, dependencies)
    ])

    expect(first?.access_token).toBe('winner-access')
    expect(second?.access_token).toBe('winner-access')
    expect(fetchToken).toHaveBeenCalledTimes(1)
    expect(stored.refresh_token).toBe('winner-refresh')
  })
})
