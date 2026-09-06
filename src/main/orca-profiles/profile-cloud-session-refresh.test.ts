import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'
import type * as ProfileCloudClient from './profile-cloud-client'
import type { ActiveOrcaProfileState } from './profile-index-store'

const { readMock, saveIfCurrentMock, clearMock, refreshMock, linkMock } = vi.hoisted(() => ({
  readMock: vi.fn(),
  saveIfCurrentMock: vi.fn((): string | null => 'memory-only'),
  clearMock: vi.fn(),
  refreshMock: vi.fn(),
  linkMock: vi.fn()
}))

vi.mock('./profile-cloud-session-store', () => ({
  readOrcaCloudSession: readMock,
  saveOrcaCloudSessionIfCurrent: saveIfCurrentMock,
  clearOrcaCloudSession: clearMock
}))

vi.mock('./profile-cloud-session-mutation', () => ({
  captureCloudSessionMutation: vi.fn(() => ({ epoch: 1, identityKey: 'identity' })),
  cloudSessionIdentity: vi.fn((localProfileId, cloud) => ({
    localProfileId,
    cloudUserId: cloud.userId,
    cloudProfileId: cloud.cloudProfileId,
    organizationId: cloud.activeOrgId ?? ''
  })),
  tombstoneCloudSession: vi.fn()
}))

vi.mock('./profile-cloud-client', async (importOriginal) => {
  const original = await importOriginal<typeof ProfileCloudClient>()
  return { ...original, refreshOrcaCloudSession: refreshMock }
})

vi.mock('./profile-cloud-index', () => ({ linkOrcaProfileToCloud: linkMock }))

import { readFreshOrcaCloudSession } from './profile-cloud-session-refresh'
import { OrcaCloudRequestError } from './profile-cloud-client'
import { onOrcaCloudSessionInvalidated } from './profile-cloud-session-invalidation'
import { forgetAmbiguousRefreshAttempt } from './profile-cloud-refresh-replay-guard'

const config = {} as OrcaCloudAuthConfig
const active = {
  profile: {
    id: 'profile-1',
    cloud: {
      userId: 'user-1',
      cloudProfileId: 'cloud-profile-1',
      activeOrgId: 'org-1'
    }
  }
} as ActiveOrcaProfileState
const staleSession = {
  accessToken: 'old-access',
  refreshToken: 'one-use-refresh',
  expiresAt: 1,
  organizations: [],
  capabilities: { flags: {}, refreshedAt: 1 }
}

describe('profile cloud session refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    forgetAmbiguousRefreshAttempt('/data\0profile-1')
    saveIfCurrentMock.mockReturnValue('memory-only')
    readMock.mockReturnValue({ status: 'found', session: staleSession, persistence: 'memory-only' })
  })

  it('does not publish a refresh whose persistent mutation snapshot became stale', async () => {
    let resolveRefresh!: (value: Record<string, unknown>) => void
    refreshMock.mockReturnValue(new Promise((resolve) => (resolveRefresh = resolve)))
    const refreshing = readFreshOrcaCloudSession(config, active, '/data')
    saveIfCurrentMock.mockReturnValue(null)
    resolveRefresh({
      accessToken: 'stale-access',
      refreshToken: 'stale-refresh',
      expiresAt: Date.now() + 600_000,
      organizations: [],
      capabilities: { flags: { 'relay.use': true }, refreshedAt: 2 },
      cloud: {
        userId: 'user-1',
        cloudProfileId: 'cloud-profile-1',
        activeOrgId: 'org-1'
      }
    })
    await expect(refreshing).rejects.toThrow('stale_cloud_session_mutation')
    expect(linkMock).not.toHaveBeenCalled()
  })

  it('single-flights concurrent rotating refresh-token use per profile and store', async () => {
    let resolveRefresh!: (value: Record<string, unknown>) => void
    refreshMock.mockReturnValue(new Promise((resolve) => (resolveRefresh = resolve)))

    const first = readFreshOrcaCloudSession(config, active, '/data')
    const second = readFreshOrcaCloudSession(config, active, '/data')
    expect(refreshMock).toHaveBeenCalledTimes(1)

    resolveRefresh({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: Date.now() + 600_000,
      organizations: [],
      capabilities: { flags: { 'relay.use': true }, refreshedAt: 2 },
      cloud: {
        userId: 'user-1',
        cloudProfileId: 'cloud-profile-1',
        activeOrgId: 'org-1'
      }
    })

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toEqual(secondResult)
    expect(saveIfCurrentMock).toHaveBeenCalledTimes(1)
    expect(linkMock).toHaveBeenCalledTimes(1)
  })

  it('notifies subscribers when an auth failure clears the stored session', async () => {
    const invalidated = vi.fn()
    const unsubscribe = onOrcaCloudSessionInvalidated(invalidated)
    refreshMock.mockRejectedValue(new OrcaCloudRequestError(401))

    await expect(readFreshOrcaCloudSession(config, active, '/data')).resolves.toEqual({
      status: 'reconnect-required'
    })

    expect(clearMock).toHaveBeenCalledTimes(1)
    expect(invalidated).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('stays silent when a concurrent rotation already replaced the failed session', async () => {
    const invalidated = vi.fn()
    const unsubscribe = onOrcaCloudSessionInvalidated(invalidated)
    refreshMock.mockRejectedValue(new OrcaCloudRequestError(401))
    readMock.mockReturnValueOnce({
      status: 'found',
      session: staleSession,
      persistence: 'memory-only'
    })
    readMock.mockReturnValueOnce({
      status: 'found',
      session: staleSession,
      persistence: 'memory-only'
    })
    readMock.mockReturnValue({
      status: 'found',
      session: { ...staleSession, refreshToken: 'rotated-refresh' },
      persistence: 'memory-only'
    })

    await expect(readFreshOrcaCloudSession(config, active, '/data')).resolves.toEqual({
      status: 'reconnect-required'
    })

    expect(clearMock).not.toHaveBeenCalled()
    expect(invalidated).not.toHaveBeenCalled()
    unsubscribe()
  })
})

describe('refresh-token replay after an ambiguous attempt', () => {
  const timeout = (): Error =>
    Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })
  const rotatedResponse = {
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    expiresAt: 4_000_000,
    organizations: [],
    capabilities: { flags: { 'relay.use': true }, refreshedAt: 2 },
    cloud: { userId: 'user-1', cloudProfileId: 'cloud-profile-1', activeOrgId: 'org-1' }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    forgetAmbiguousRefreshAttempt('/data\0profile-1')
    saveIfCurrentMock.mockReturnValue('memory-only')
    readMock.mockReturnValue({ status: 'found', session: staleSession, persistence: 'memory-only' })
  })

  it('never resends a refresh token whose attempt timed out', async () => {
    refreshMock.mockRejectedValue(timeout())

    await expect(readFreshOrcaCloudSession(config, active, '/data')).rejects.toThrow(
      'The operation timed out.'
    )
    expect(refreshMock).toHaveBeenCalledTimes(1)

    // The retry loop above this module re-enters immediately; it must not turn
    // one lost reply into a second POST of the same token.
    await expect(readFreshOrcaCloudSession(config, active, '/data')).rejects.toThrow(
      'orca_cloud_refresh_replay_blocked'
    )
    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(clearMock).not.toHaveBeenCalled()
  })

  it('adopts the stored session when a timed-out attempt was rotated elsewhere', async () => {
    const rotated = { ...staleSession, refreshToken: 'rotated-refresh', expiresAt: 4_000_000 }
    refreshMock.mockRejectedValue(timeout())
    readMock
      .mockReturnValueOnce({ status: 'found', session: staleSession, persistence: 'memory-only' })
      .mockReturnValueOnce({ status: 'found', session: staleSession, persistence: 'memory-only' })
      .mockReturnValue({ status: 'found', session: rotated, persistence: 'memory-only' })

    await expect(readFreshOrcaCloudSession(config, active, '/data')).resolves.toEqual({
      status: 'found',
      session: rotated
    })
    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(saveIfCurrentMock).not.toHaveBeenCalled()
  })

  it('retries once after a definitive 5xx, which cannot have rotated the token', async () => {
    refreshMock
      .mockRejectedValueOnce(new OrcaCloudRequestError(503))
      .mockResolvedValueOnce(rotatedResponse)

    const result = await readFreshOrcaCloudSession(config, active, '/data')

    expect(refreshMock).toHaveBeenCalledTimes(2)
    expect(refreshMock).toHaveBeenNthCalledWith(2, config, staleSession)
    expect(result).toEqual({
      status: 'found',
      session: expect.objectContaining({
        accessToken: 'new-access',
        refreshToken: 'new-refresh'
      })
    })
  })

  it('gives a definitive 5xx exactly one retry', async () => {
    refreshMock.mockRejectedValue(new OrcaCloudRequestError(503))

    await expect(readFreshOrcaCloudSession(config, active, '/data')).rejects.toThrow(
      'orca_cloud_request_failed_503'
    )
    expect(refreshMock).toHaveBeenCalledTimes(2)
    expect(clearMock).not.toHaveBeenCalled()
  })

  it('marks a 401 that follows an ambiguous attempt as a possible self-replay', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const invalidated = vi.fn()
    const unsubscribe = onOrcaCloudSessionInvalidated(invalidated)
    refreshMock.mockRejectedValueOnce(timeout())

    await expect(readFreshOrcaCloudSession(config, active, '/data')).rejects.toThrow(
      'The operation timed out.'
    )

    now.mockReturnValue(1_000_000 + 31_000)
    refreshMock.mockRejectedValueOnce(new OrcaCloudRequestError(401))

    await expect(readFreshOrcaCloudSession(config, active, '/data')).resolves.toEqual({
      status: 'reconnect-required'
    })

    expect(refreshMock).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.flat().join(' ')).toContain('orca_cloud_refresh_possible_replay')
    expect(clearMock).toHaveBeenCalledTimes(1)
    expect(invalidated).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('does not mark a 401 that follows no ambiguous attempt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    refreshMock.mockRejectedValue(new OrcaCloudRequestError(401))

    await expect(readFreshOrcaCloudSession(config, active, '/data')).resolves.toEqual({
      status: 'reconnect-required'
    })

    expect(warn.mock.calls.flat().join(' ')).not.toContain('orca_cloud_refresh_possible_replay')
    expect(clearMock).toHaveBeenCalledTimes(1)
  })
})
