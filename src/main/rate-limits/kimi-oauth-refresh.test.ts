import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { lock as ProperLock } from 'proper-lockfile'
import { afterEach, describe, expect, it, vi } from 'vitest'

const lockMock = vi.hoisted(() => vi.fn())

vi.mock('proper-lockfile', () => ({ lock: lockMock }))
import type { KimiCredentialLocation } from './kimi-credential-location'
import {
  acquireKimiRefreshLock,
  refreshKimiCredentials,
  type KimiCredentials,
  type KimiRefreshError,
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
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    lockMock.mockReset()
  })

  it('uses Kimi proper-lockfile options and releases after success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-kimi-lock-'))
    const target = join(root, 'oauth', 'kimi-code')
    const release = vi.fn().mockResolvedValue(undefined)
    lockMock.mockResolvedValue(release)

    await expect(acquireKimiRefreshLock(target, async () => 'done')).resolves.toBe('done')

    expect(lockMock).toHaveBeenCalledWith(target, {
      retries: { retries: 120, factor: 1, minTimeout: 500, maxTimeout: 1000 },
      stale: 5000,
      realpath: false
    })
    expect(release).toHaveBeenCalledOnce()
    rmSync(root, { recursive: true, force: true })
  })

  it('serializes overlapping actions through the production proper-lockfile path', async () => {
    const { lock: actualLock } = await vi.importActual<{ lock: typeof ProperLock }>(
      'proper-lockfile'
    )
    lockMock.mockImplementation(actualLock)
    const root = mkdtempSync(join(tmpdir(), 'orca-kimi-lock-'))
    const target = join(root, 'oauth', 'kimi-code')
    const events: string[] = []
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })

    const first = acquireKimiRefreshLock(target, async () => {
      events.push('first:start')
      markFirstStarted()
      await new Promise((resolve) => setTimeout(resolve, 20))
      events.push('first:end')
    })
    await firstStarted
    const second = acquireKimiRefreshLock(target, async () => {
      events.push('second:start')
      events.push('second:end')
    })
    await Promise.all([first, second])

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
    rmSync(root, { recursive: true, force: true })
  })

  it('fails closed when production lock acquisition fails', async () => {
    const action = vi.fn()
    lockMock.mockRejectedValue(new Error('lock unavailable'))

    await expect(acquireKimiRefreshLock('/tmp/kimi-lock-target', action)).rejects.toThrow(
      'lock unavailable'
    )
    expect(action).not.toHaveBeenCalled()
  })

  it('releases the production lock after the protected action throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-kimi-lock-'))
    const target = join(root, 'oauth', 'kimi-code')
    const release = vi.fn().mockResolvedValue(undefined)
    lockMock.mockResolvedValue(release)

    await expect(
      acquireKimiRefreshLock(target, async () => {
        throw new Error('refresh failed')
      })
    ).rejects.toThrow('refresh failed')
    expect(release).toHaveBeenCalledOnce()
    rmSync(root, { recursive: true, force: true })
  })

  it.each([
    ['the disable flag', () => vi.stubEnv('KIMI_DISABLE_OAUTH_LOCK', '1')],
    ['Windows', () => vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')]
  ])('does not acquire a filesystem lock on %s', async (_name, configure) => {
    configure()

    await expect(acquireKimiRefreshLock('/unwritable/kimi', async () => 'done')).resolves.toBe(
      'done'
    )
    expect(lockMock).not.toHaveBeenCalled()
  })

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

  it('accepts only a changed-token fresh winner after unauthorized refresh', async () => {
    const initial = expired('initial-refresh')
    const winner = {
      access_token: 'winner-access',
      refresh_token: 'winner-refresh',
      expires_at: 1000
    }
    const reads = [initial, winner]
    const saveCredentials = vi.fn()
    const delay = vi.fn().mockResolvedValue(undefined)
    const dependencies: KimiRefreshDependencies = {
      acquireLock: async (_target, action) => action(),
      readCredentials: () => reads.shift() ?? winner,
      saveCredentials,
      fetchToken: vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response),
      nowSeconds: () => 100,
      delay
    }

    await expect(refreshKimiCredentials(initial, location, dependencies)).resolves.toBe(winner)
    expect(delay).toHaveBeenCalledWith(100)
    expect(saveCredentials).not.toHaveBeenCalled()
  })

  it('persists a revoked tombstone and rethrows unauthorized refresh without a winner', async () => {
    const initial = expired('initial-refresh')
    const saveCredentials = vi.fn()
    const dependencies: KimiRefreshDependencies = {
      acquireLock: async (_target, action) => action(),
      readCredentials: () => initial,
      saveCredentials,
      fetchToken: vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response),
      nowSeconds: () => 100,
      delay: vi.fn().mockResolvedValue(undefined)
    }

    await expect(refreshKimiCredentials(initial, location, dependencies)).rejects.toMatchObject({
      name: 'KimiRefreshError',
      kind: 'unauthorized',
      status: 403
    } satisfies Partial<KimiRefreshError>)
    expect(saveCredentials).toHaveBeenCalledWith(location.credentialsPath, {
      ...initial,
      access_token: '',
      refresh_token: ''
    })
  })

  it('rethrows non-auth refresh failures without overwriting credentials', async () => {
    const initial = expired('initial-refresh')
    const saveCredentials = vi.fn()
    const dependencies: KimiRefreshDependencies = {
      acquireLock: async (_target, action) => action(),
      readCredentials: () => initial,
      saveCredentials,
      fetchToken: vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response),
      nowSeconds: () => 100,
      delay: vi.fn().mockResolvedValue(undefined)
    }

    await expect(refreshKimiCredentials(initial, location, dependencies)).rejects.toMatchObject({
      name: 'KimiRefreshError',
      kind: 'request',
      status: 500
    } satisfies Partial<KimiRefreshError>)
    expect(saveCredentials).not.toHaveBeenCalled()
  })
})
