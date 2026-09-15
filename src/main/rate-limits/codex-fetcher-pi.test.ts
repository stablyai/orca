import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, getPiCodexCredentialMock, ptySpawnMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  getPiCodexCredentialMock: vi.fn(),
  ptySpawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: childSpawnMock }))
vi.mock('node-pty', () => ({ spawn: ptySpawnMock }))
vi.mock('../codex-accounts/pi-codex-auth', () => ({
  hasPiCodexAuthSource: () => true,
  readPiCodexAuthSource: () => ({ providerAccountId: 'account-123' }),
  getPiCodexCredential: getPiCodexCredentialMock
}))

import { fetchCodexRateLimits } from './codex-fetcher'

describe('Pi-linked Codex rate-limit requests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getPiCodexCredentialMock.mockResolvedValue({
      accessToken: 'pi-access-token',
      providerAccountId: 'account-123',
      email: 'user@example.com'
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses Pi auth and the direct backend without launching Codex', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 12, limit_window_seconds: 18_000 },
            secondary_window: { used_percent: 34, limit_window_seconds: 604_800 }
          },
          rate_limit_reset_credits: { available_count: 0, credits: [] }
        })
      } as Response)
    )

    await expect(
      fetchCodexRateLimits({ codexHomePath: '/managed/pi/home' })
    ).resolves.toMatchObject({
      status: 'ok',
      planType: 'plus',
      session: { usedPercent: 12 },
      weekly: { usedPercent: 34 }
    })
    expect(fetch).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer pi-access-token',
          'ChatGPT-Account-Id': 'account-123'
        })
      })
    )
    expect(childSpawnMock).not.toHaveBeenCalled()
    expect(ptySpawnMock).not.toHaveBeenCalled()
  })

  it('rejects a different Pi account without falling back to Codex', async () => {
    getPiCodexCredentialMock.mockResolvedValue({
      accessToken: 'other-access-token',
      providerAccountId: 'other-account',
      email: 'other@example.com'
    })
    vi.stubGlobal('fetch', vi.fn())

    await expect(
      fetchCodexRateLimits({ codexHomePath: '/managed/pi/home' })
    ).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('different Codex account')
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(childSpawnMock).not.toHaveBeenCalled()
    expect(ptySpawnMock).not.toHaveBeenCalled()
  })

  it('does not fall back to Codex on backend 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, body: { cancel: vi.fn() } } as never)
    )

    await expect(
      fetchCodexRateLimits({ codexHomePath: '/managed/pi/home' })
    ).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('Pi Codex usage is unavailable')
    })
    expect(childSpawnMock).not.toHaveBeenCalled()
    expect(ptySpawnMock).not.toHaveBeenCalled()
  })
})
