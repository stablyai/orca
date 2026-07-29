import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handlers,
  createCloudLinkedOrcaProfileMock,
  connectCurrentOrcaProfileMock,
  getCurrentOrcaProfileAuthStatusMock,
  refreshCurrentOrcaProfileAuthMock,
  selectCurrentOrcaProfileOrgMock,
  signOutCurrentOrcaProfileMock
} = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  createCloudLinkedOrcaProfileMock: vi.fn(),
  connectCurrentOrcaProfileMock: vi.fn(),
  getCurrentOrcaProfileAuthStatusMock: vi.fn(),
  refreshCurrentOrcaProfileAuthMock: vi.fn(),
  selectCurrentOrcaProfileOrgMock: vi.fn(),
  signOutCurrentOrcaProfileMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    exit: vi.fn(),
    getPath: () => '/tmp/orca-user-data',
    relaunch: vi.fn()
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('../tray/system-tray', () => ({
  destroySystemTray: vi.fn()
}))

vi.mock('../orca-profiles/profile-index-store', () => ({
  createLocalOrcaProfile: vi.fn(),
  getOrcaProfileListState: vi.fn(),
  seedNewOrcaProfileTelemetryConsent: vi.fn(),
  setActiveOrcaProfile: vi.fn()
}))

vi.mock('../orca-profiles/profile-project-transfer', () => ({
  transferOrcaProfileProject: vi.fn()
}))

vi.mock('../orca-profiles/profile-cloud-service', () => ({
  createCloudLinkedOrcaProfile: createCloudLinkedOrcaProfileMock,
  connectCurrentOrcaProfile: connectCurrentOrcaProfileMock,
  getCurrentOrcaProfileAuthStatus: getCurrentOrcaProfileAuthStatusMock,
  refreshCurrentOrcaProfileAuth: refreshCurrentOrcaProfileAuthMock,
  selectCurrentOrcaProfileOrg: selectCurrentOrcaProfileOrgMock,
  signOutCurrentOrcaProfile: signOutCurrentOrcaProfileMock
}))

import { registerOrcaProfileHandlers } from './orca-profiles'

describe('registerOrcaProfileHandlers auth channels', () => {
  beforeEach(() => {
    handlers.clear()
    createCloudLinkedOrcaProfileMock.mockReset()
    connectCurrentOrcaProfileMock.mockReset()
    getCurrentOrcaProfileAuthStatusMock.mockReset()
    refreshCurrentOrcaProfileAuthMock.mockReset()
    selectCurrentOrcaProfileOrgMock.mockReset()
    signOutCurrentOrcaProfileMock.mockReset()
  })

  it('returns auth status for the current profile', async () => {
    const status = {
      activeProfileId: 'local-default',
      configured: false,
      state: 'unconfigured',
      persistence: 'none'
    }
    getCurrentOrcaProfileAuthStatusMock.mockReturnValue(status)
    registerOrcaProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(Promise.resolve(handlers.get('orcaProfiles:authStatus')?.(null))).resolves.toBe(
      status
    )
    expect(getCurrentOrcaProfileAuthStatusMock).toHaveBeenCalledWith('/tmp/orca-user-data')
  })

  it('connects and signs out the current profile through the cloud service', async () => {
    const connectResult = { status: 'unconfigured', auth: { activeProfileId: 'local-default' } }
    const signOutResult = { status: 'signed-out', auth: { activeProfileId: 'local-default' } }
    connectCurrentOrcaProfileMock.mockResolvedValue(connectResult)
    signOutCurrentOrcaProfileMock.mockResolvedValue(signOutResult)
    registerOrcaProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(
      Promise.resolve(handlers.get('orcaProfiles:connectCurrent')?.(null))
    ).resolves.toBe(connectResult)
    await expect(
      Promise.resolve(handlers.get('orcaProfiles:signOutCurrent')?.(null))
    ).resolves.toBe(signOutResult)
    expect(connectCurrentOrcaProfileMock).toHaveBeenCalledWith('/tmp/orca-user-data')
    expect(signOutCurrentOrcaProfileMock).toHaveBeenCalledWith('/tmp/orca-user-data')
  })

  it('refreshes profile auth through the cloud service', async () => {
    const refreshResult = { status: 'refreshed', auth: { activeProfileId: 'local-default' } }
    refreshCurrentOrcaProfileAuthMock.mockResolvedValue(refreshResult)
    registerOrcaProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(Promise.resolve(handlers.get('orcaProfiles:refreshAuth')?.(null))).resolves.toBe(
      refreshResult
    )
    expect(refreshCurrentOrcaProfileAuthMock).toHaveBeenCalledWith('/tmp/orca-user-data')
  })

  it('validates organization selection before calling the cloud service', async () => {
    const selectResult = { status: 'selected', auth: { activeProfileId: 'local-default' } }
    selectCurrentOrcaProfileOrgMock.mockResolvedValue(selectResult)
    registerOrcaProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(
      Promise.resolve(handlers.get('orcaProfiles:selectOrg')?.(null, { orgId: ' org-1 ' }))
    ).resolves.toBe(selectResult)
    expect(selectCurrentOrcaProfileOrgMock).toHaveBeenCalledWith('/tmp/orca-user-data', 'org-1')

    await expect(
      Promise.resolve(handlers.get('orcaProfiles:selectOrg')?.(null, { orgId: ' ' }))
    ).rejects.toThrow('invalid_orca_profile_org_selection')
  })

  it('creates cloud-linked profiles with trimmed optional args', async () => {
    const createResult = {
      status: 'created',
      auth: { activeProfileId: 'local-default' },
      activeProfileId: 'local-default',
      profiles: [],
      profile: { id: 'cloud-1' }
    }
    createCloudLinkedOrcaProfileMock.mockResolvedValue(createResult)
    registerOrcaProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(
      Promise.resolve(
        handlers.get('orcaProfiles:createCloudLinked')?.(null, { orgId: ' org-1 ', name: ' Acme ' })
      )
    ).resolves.toBe(createResult)
    expect(createCloudLinkedOrcaProfileMock).toHaveBeenCalledWith('/tmp/orca-user-data', {
      orgId: 'org-1',
      name: 'Acme'
    })
  })
})
