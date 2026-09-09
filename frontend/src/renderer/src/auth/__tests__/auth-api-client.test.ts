// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchCurrentUser,
  loginLocal,
  logoutUser,
  fetchAuthConfig,
  refreshSession
} from '../auth-api-client'
import { AuthError } from '../auth-types'

const mockUser = {
  id: 'u1',
  email: 'alice@co.com',
  name: 'Alice',
  role: 'developer' as const,
  provider: 'none' as const
}

describe('AuthApiClient', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── fetchCurrentUser ──────────────────────────────────────────────────────

  describe('fetchCurrentUser', () => {
    it('returns AuthUser when session is valid (200)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify(mockUser), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      const user = await fetchCurrentUser()
      expect(user).toMatchObject({ email: 'alice@co.com', role: 'developer' })
      expect(fetch).toHaveBeenCalledWith(
        '/auth/me',
        expect.objectContaining({ credentials: 'include' })
      )
    })

    it('returns null when no session (401)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 401 }))
      const user = await fetchCurrentUser()
      expect(user).toBeNull()
    })

    it('throws on server error (500)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 500 }))
      await expect(fetchCurrentUser()).rejects.toThrow('Server error: 500')
    })

    it('throws on network error', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'))
      await expect(fetchCurrentUser()).rejects.toThrow('Network error')
    })
  })

  // ── loginLocal ────────────────────────────────────────────────────────────

  describe('loginLocal', () => {
    it('returns AuthUser on successful login (200)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify(mockUser), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      const user = await loginLocal('alice@co.com', 'password123')
      expect(user).toMatchObject({ email: 'alice@co.com' })
      expect(fetch).toHaveBeenCalledWith(
        '/auth/local',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ email: 'alice@co.com', password: 'password123' }),
          credentials: 'include'
        })
      )
    })

    it('throws AuthError with code=invalid_credentials on 401', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Invalid credentials' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      const err = await loginLocal('bad@co.com', 'wrong').catch((e) => e)
      expect(err).toBeInstanceOf(AuthError)
      expect(err.code).toBe('invalid_credentials')
      expect(err.message).toBe('Invalid credentials')
    })

    it('throws AuthError on 500 server error', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('{}', {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      await expect(loginLocal('a@b.com', 'p')).rejects.toBeInstanceOf(AuthError)
    })
  })

  // ── logoutUser ────────────────────────────────────────────────────────────

  describe('logoutUser', () => {
    it('calls POST /auth/logout with credentials', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 200 }))
      await logoutUser()
      expect(fetch).toHaveBeenCalledWith(
        '/auth/logout',
        expect.objectContaining({ method: 'POST', credentials: 'include' })
      )
    })
  })

  // ── refreshSession ────────────────────────────────────────────────────────

  describe('refreshSession', () => {
    it('returns AuthUser when the rotation succeeds (200)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify(mockUser), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      const user = await refreshSession()
      expect(user).toMatchObject({ email: 'alice@co.com', role: 'developer' })
      expect(fetch).toHaveBeenCalledWith(
        '/auth/refresh',
        expect.objectContaining({ method: 'POST', credentials: 'include' })
      )
    })

    it('returns null when the session was revoked (403)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 403 }))
      const user = await refreshSession()
      expect(user).toBeNull()
    })

    it('returns null when unauthenticated (401)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 401 }))
      const user = await refreshSession()
      expect(user).toBeNull()
    })

    it('throws on server error (500)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 500 }))
      await expect(refreshSession()).rejects.toThrow('Server error: 500')
    })

    it('throws on network error', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'))
      await expect(refreshSession()).rejects.toThrow('Network error')
    })
  })

  // ── fetchAuthConfig ───────────────────────────────────────────────────────

  describe('fetchAuthConfig', () => {
    it('returns providers list on success', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ providers: ['github', 'google'], localEnabled: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      const config = await fetchAuthConfig()
      expect(config.providers).toEqual(['github', 'google'])
      expect(config.localEnabled).toBe(true)
    })

    it('returns fallback on network error', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'))
      const config = await fetchAuthConfig()
      expect(config).toEqual({ providers: [], localEnabled: true })
    })
  })
})
