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
})
