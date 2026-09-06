import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { OrcaCloudSession } from '../../orca-profiles/profile-cloud-session-store'
import type { ActiveOrcaProfileState } from '../../orca-profiles/profile-index-store'

const { ensureActiveMock, readFreshSessionMock, refreshAuthMock } = vi.hoisted(() => ({
  ensureActiveMock: vi.fn(),
  readFreshSessionMock: vi.fn(),
  refreshAuthMock: vi.fn()
}))

vi.mock('../../orca-profiles/profile-index-store', () => ({
  ensureActiveOrcaProfile: ensureActiveMock
}))

vi.mock('../../orca-profiles/profile-cloud-session-refresh', () => ({
  readFreshOrcaCloudSession: readFreshSessionMock
}))

vi.mock('../../orca-profiles/profile-cloud-capability-refresh', () => ({
  refreshCurrentOrcaProfileAuth: refreshAuthMock
}))

import {
  readRelayAuthContext,
  resetRelayCapabilityRefreshStateForTests
} from './relay-auth-context'

const authConfig = {} as OrcaCloudAuthConfig

function activeProfile(profileId: string): ActiveOrcaProfileState {
  return {
    profile: {
      id: profileId,
      cloud: {
        userId: 'user-1',
        cloudProfileId: 'cloud-profile-1',
        activeOrgId: 'org-1'
      }
    }
  } as ActiveOrcaProfileState
}

function foundSession(relayEntitled: boolean): {
  status: 'found'
  session: OrcaCloudSession
  persistence: 'memory-only'
} {
  return {
    status: 'found',
    persistence: 'memory-only',
    session: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 600_000,
      capabilities: {
        flags: { 'relay.use': relayEntitled },
        refreshedAt: Date.now()
      }
    }
  }
}

describe('readRelayAuthContext', () => {
  beforeEach(() => {
    resetRelayCapabilityRefreshStateForTests()
    vi.clearAllMocks()
    refreshAuthMock.mockResolvedValue({ status: 'refreshed' })
  })

  afterEach(() => {
    resetRelayCapabilityRefreshStateForTests()
  })

  it('uses an active cached relay capability without refreshing it', async () => {
    ensureActiveMock.mockReturnValue(activeProfile('profile-enabled'))
    readFreshSessionMock.mockResolvedValue(foundSession(true))

    await expect(readRelayAuthContext(authConfig, '/data/enabled')).resolves.toMatchObject({
      accessToken: 'access-token',
      relayEntitled: true
    })
    expect(refreshAuthMock).not.toHaveBeenCalled()
  })

  it('refreshes a cached inactive relay capability before deciding the relay is unavailable', async () => {
    ensureActiveMock.mockReturnValue(activeProfile('profile-stale'))
    readFreshSessionMock
      .mockResolvedValueOnce(foundSession(false))
      .mockResolvedValueOnce(foundSession(true))

    await expect(readRelayAuthContext(authConfig, '/data/stale')).resolves.toMatchObject({
      accessToken: 'access-token',
      relayEntitled: true
    })
    expect(refreshAuthMock).toHaveBeenCalledOnce()
    expect(refreshAuthMock).toHaveBeenCalledWith('/data/stale')
  })

  it('single-flights concurrent relay capability refreshes', async () => {
    ensureActiveMock.mockReturnValue(activeProfile('profile-concurrent'))
    let refreshed = false
    let resolveRefresh!: () => void
    refreshAuthMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = () => {
            refreshed = true
            resolve({ status: 'refreshed' })
          }
        })
    )
    readFreshSessionMock.mockImplementation(() => Promise.resolve(foundSession(refreshed)))

    const first = readRelayAuthContext(authConfig, '/data/concurrent')
    const second = readRelayAuthContext(authConfig, '/data/concurrent')
    await vi.waitFor(() => expect(refreshAuthMock).toHaveBeenCalledOnce())
    resolveRefresh()

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ relayEntitled: true }),
      expect.objectContaining({ relayEntitled: true })
    ])
  })

  it('keeps the relay inactive when refreshed capabilities still deny access', async () => {
    ensureActiveMock.mockReturnValue(activeProfile('profile-disabled'))
    readFreshSessionMock.mockResolvedValue(foundSession(false))

    await expect(readRelayAuthContext(authConfig, '/data/disabled')).resolves.toMatchObject({
      relayEntitled: false
    })
    expect(refreshAuthMock).toHaveBeenCalledOnce()
  })

  it('rate-limits repeated refreshes while the relay capability remains inactive', async () => {
    ensureActiveMock.mockReturnValue(activeProfile('profile-rate-limited'))
    readFreshSessionMock.mockResolvedValue(foundSession(false))

    await readRelayAuthContext(authConfig, '/data/rate-limited')
    await readRelayAuthContext(authConfig, '/data/rate-limited')

    expect(refreshAuthMock).toHaveBeenCalledOnce()
  })

  it('clears cooldown state so the same profile key can be reused in isolation', async () => {
    ensureActiveMock.mockReturnValue(activeProfile('profile-reset'))
    readFreshSessionMock.mockResolvedValue(foundSession(false))

    await readRelayAuthContext(authConfig, '/data/reset')
    resetRelayCapabilityRefreshStateForTests()
    await readRelayAuthContext(authConfig, '/data/reset')

    expect(refreshAuthMock).toHaveBeenCalledTimes(2)
  })
})
