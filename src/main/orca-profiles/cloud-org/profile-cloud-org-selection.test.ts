import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getOrcaCloudAuthConfig } from '../cloud-auth/profile-cloud-auth-config'
import type { ActiveOrcaProfileState } from '../profile-index-store'
import { getOrcaCloudTokenEpoch } from '../cloud-token-epoch'

const mocks = vi.hoisted(() => ({
  calls: new Array<string>(),
  refresh: vi.fn(),
  commit: vi.fn()
}))

vi.mock('../cloud-auth/profile-cloud-client', () => ({
  OrcaCloudRequestError: class extends Error {
    statusCode = 0
  },
  selectOrcaCloudOrg: async (_config: unknown, _session: unknown, orgId: string | null) => {
    mocks.calls.push('select')
    return {
      cloud: { userId: 'user-a', cloudProfileId: 'cp-a', ...(orgId ? { activeOrgId: orgId } : {}) },
      capabilities: { flags: {}, refreshedAt: 1 }
    }
  }
}))

vi.mock('../cloud-session/profile-cloud-session-refresh', () => ({
  forceRefreshOrcaCloudSession: (...args: unknown[]) => {
    mocks.calls.push('refresh')
    return mocks.refresh(...args)
  }
}))

vi.mock('../cloud-session/profile-cloud-session-owner', () => ({
  beginCloudSessionRelink: () => ({ generation: 0, linkVersion: 1 }),
  readCloudSession: () => ({ status: 'found', session: { accessToken: 'a', refreshToken: 'r' } }),
  commitCloudSessionRelink: (...args: unknown[]) => {
    mocks.calls.push('commit')
    return mocks.commit(...args)
  }
}))

const { selectCloudOrg, ORG_SWITCH_REFRESH_FAILED } = await import('./profile-cloud-org-selection')

const profile = {
  id: 'p1',
  name: 'Test',
  avatar: { kind: 'initials', initials: 'T', color: 'neutral' },
  kind: 'cloud-linked',
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
  cloud: {
    userId: 'user-a',
    cloudProfileId: 'cp-a',
    email: 'a@example.test',
    activeOrgId: 'org-old',
    linkedAt: 1
  }
} satisfies ActiveOrcaProfileState['profile']
const active: ActiveOrcaProfileState = {
  index: { schemaVersion: 1, activeProfileId: 'p1', profiles: [profile] },
  profile,
  dataFile: '/tmp/unused/data',
  stateDatabaseFile: '/tmp/unused/state',
  profileDirectory: '/tmp/unused'
}

const authConfig = getOrcaCloudAuthConfig(
  { ORCA_CLOUD_API_URL: 'http://127.0.0.1:9', ORCA_CLOUD_CLIENT_ID: 'test-client' },
  false
)

function select() {
  return selectCloudOrg({
    config: authConfig.configured ? authConfig.config : expect.fail('auth config'),
    active,
    userDataPath: '/tmp/unused',
    orgId: 'org-new'
  })
}

describe('selectCloudOrg', () => {
  beforeEach(() => {
    mocks.calls.length = 0
    mocks.refresh.mockReset()
    mocks.commit.mockReset()
  })

  it('publishes the new team only after the session refreshed for it, then drops sandbox tokens', async () => {
    mocks.refresh.mockResolvedValue({ status: 'found', session: {} })
    mocks.commit.mockReturnValue({ activeProfileId: 'p1', profiles: [] })
    const epoch = getOrcaCloudTokenEpoch()
    await expect(select()).resolves.toEqual({ activeProfileId: 'p1', profiles: [] })
    expect(mocks.calls).toEqual(['select', 'refresh', 'commit'])
    expect(getOrcaCloudTokenEpoch()).toBeGreaterThan(epoch)
  })

  it('a failed refresh fails the switch loudly and leaves the old team in place', async () => {
    mocks.refresh.mockRejectedValue(new Error('network down'))
    await expect(select()).rejects.toThrow('network down')
    expect(mocks.calls).toEqual(['select', 'refresh'])
    expect(mocks.commit).not.toHaveBeenCalled()
  })

  it('a refresh that needs reconnecting fails the switch with a readable message', async () => {
    mocks.refresh.mockResolvedValue({ status: 'reconnect-required' })
    await expect(select()).rejects.toThrow(ORG_SWITCH_REFRESH_FAILED)
    expect(mocks.commit).not.toHaveBeenCalled()
  })
})
