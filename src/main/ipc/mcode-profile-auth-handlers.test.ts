import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handlers,
  createCloudLinkedMCodeProfileMock,
  connectCurrentMCodeProfileMock,
  getCurrentMCodeProfileAuthStatusMock,
  refreshCurrentMCodeProfileAuthMock,
  selectCurrentMCodeProfileOrgMock,
  signOutCurrentMCodeProfileMock
} = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  createCloudLinkedMCodeProfileMock: vi.fn(),
  connectCurrentMCodeProfileMock: vi.fn(),
  getCurrentMCodeProfileAuthStatusMock: vi.fn(),
  refreshCurrentMCodeProfileAuthMock: vi.fn(),
  selectCurrentMCodeProfileOrgMock: vi.fn(),
  signOutCurrentMCodeProfileMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    exit: vi.fn(),
    getPath: () => '/tmp/mcode-user-data',
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

vi.mock('../mcode-profiles/profile-index-store', () => ({
  createLocalMCodeProfile: vi.fn(),
  getMCodeProfileListState: vi.fn(),
  seedNewMCodeProfileTelemetryConsent: vi.fn(),
  setActiveMCodeProfile: vi.fn()
}))

vi.mock('../mcode-profiles/profile-project-transfer', () => ({
  transferMCodeProfileProject: vi.fn()
}))

vi.mock('../mcode-profiles/profile-cloud-service', () => ({
  createCloudLinkedMCodeProfile: createCloudLinkedMCodeProfileMock,
  connectCurrentMCodeProfile: connectCurrentMCodeProfileMock,
  getCurrentMCodeProfileAuthStatus: getCurrentMCodeProfileAuthStatusMock,
  refreshCurrentMCodeProfileAuth: refreshCurrentMCodeProfileAuthMock,
  selectCurrentMCodeProfileOrg: selectCurrentMCodeProfileOrgMock,
  signOutCurrentMCodeProfile: signOutCurrentMCodeProfileMock
}))

import { registerMCodeProfileHandlers } from './mcode-profiles'

describe('registerMCodeProfileHandlers auth channels', () => {
  beforeEach(() => {
    handlers.clear()
    createCloudLinkedMCodeProfileMock.mockReset()
    connectCurrentMCodeProfileMock.mockReset()
    getCurrentMCodeProfileAuthStatusMock.mockReset()
    refreshCurrentMCodeProfileAuthMock.mockReset()
    selectCurrentMCodeProfileOrgMock.mockReset()
    signOutCurrentMCodeProfileMock.mockReset()
  })

  it('returns auth status for the current profile', async () => {
    const status = {
      activeProfileId: 'local-default',
      configured: false,
      state: 'unconfigured',
      persistence: 'none'
    }
    getCurrentMCodeProfileAuthStatusMock.mockReturnValue(status)
    registerMCodeProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(Promise.resolve(handlers.get('mcodeProfiles:authStatus')?.(null))).resolves.toBe(
      status
    )
    expect(getCurrentMCodeProfileAuthStatusMock).toHaveBeenCalledWith('/tmp/mcode-user-data')
  })

  it('connects and signs out the current profile through the cloud service', async () => {
    const connectResult = { status: 'unconfigured', auth: { activeProfileId: 'local-default' } }
    const signOutResult = { status: 'signed-out', auth: { activeProfileId: 'local-default' } }
    connectCurrentMCodeProfileMock.mockResolvedValue(connectResult)
    signOutCurrentMCodeProfileMock.mockResolvedValue(signOutResult)
    registerMCodeProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(
      Promise.resolve(handlers.get('mcodeProfiles:connectCurrent')?.(null))
    ).resolves.toBe(connectResult)
    await expect(
      Promise.resolve(handlers.get('mcodeProfiles:signOutCurrent')?.(null))
    ).resolves.toBe(signOutResult)
    expect(connectCurrentMCodeProfileMock).toHaveBeenCalledWith('/tmp/mcode-user-data')
    expect(signOutCurrentMCodeProfileMock).toHaveBeenCalledWith('/tmp/mcode-user-data')
  })

  it('refreshes profile auth through the cloud service', async () => {
    const refreshResult = { status: 'refreshed', auth: { activeProfileId: 'local-default' } }
    refreshCurrentMCodeProfileAuthMock.mockResolvedValue(refreshResult)
    registerMCodeProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(Promise.resolve(handlers.get('mcodeProfiles:refreshAuth')?.(null))).resolves.toBe(
      refreshResult
    )
    expect(refreshCurrentMCodeProfileAuthMock).toHaveBeenCalledWith('/tmp/mcode-user-data')
  })

  it('validates organization selection before calling the cloud service', async () => {
    const selectResult = { status: 'selected', auth: { activeProfileId: 'local-default' } }
    selectCurrentMCodeProfileOrgMock.mockResolvedValue(selectResult)
    registerMCodeProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(
      Promise.resolve(handlers.get('mcodeProfiles:selectOrg')?.(null, { orgId: ' org-1 ' }))
    ).resolves.toBe(selectResult)
    expect(selectCurrentMCodeProfileOrgMock).toHaveBeenCalledWith('/tmp/mcode-user-data', 'org-1')

    await expect(
      Promise.resolve(handlers.get('mcodeProfiles:selectOrg')?.(null, { orgId: ' ' }))
    ).rejects.toThrow('invalid_mcode_profile_org_selection')
  })

  it('creates cloud-linked profiles with trimmed optional args', async () => {
    const createResult = {
      status: 'created',
      auth: { activeProfileId: 'local-default' },
      activeProfileId: 'local-default',
      profiles: [],
      profile: { id: 'cloud-1' }
    }
    createCloudLinkedMCodeProfileMock.mockResolvedValue(createResult)
    registerMCodeProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(
      Promise.resolve(
        handlers.get('mcodeProfiles:createCloudLinked')?.(null, { orgId: ' org-1 ', name: ' Acme ' })
      )
    ).resolves.toBe(createResult)
    expect(createCloudLinkedMCodeProfileMock).toHaveBeenCalledWith('/tmp/mcode-user-data', {
      orgId: 'org-1',
      name: 'Acme'
    })
  })
})
