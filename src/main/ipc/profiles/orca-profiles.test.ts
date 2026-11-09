import type * as NewProfileStateModule from '../../orca-profiles/new-profile-state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProfileStoragePaths from '../../orca-profiles/profile-storage-paths'
import type * as ProfileCloudService from '../../orca-profiles/profile-cloud-service'

const {
  handlers,
  appExitMock,
  appQuitMock,
  appRelaunchMock,
  relaunchAppMock,
  destroySystemTrayMock,
  createLocalOrcaProfileMock,
  createCloudLinkedOrcaProfileMock,
  getOrcaProfileListStateMock,
  initializeNewOrcaProfileStateMock,
  setActiveOrcaProfileMock,
  transferOrcaProfileProjectMock,
  hasOrcaProfileStateDatabaseMock
} = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  appExitMock: vi.fn(),
  appQuitMock: vi.fn(),
  appRelaunchMock: vi.fn(),
  relaunchAppMock: vi.fn(),
  destroySystemTrayMock: vi.fn(),
  createLocalOrcaProfileMock: vi.fn(),
  createCloudLinkedOrcaProfileMock: vi.fn(),
  getOrcaProfileListStateMock: vi.fn(),
  initializeNewOrcaProfileStateMock: vi.fn(),
  setActiveOrcaProfileMock: vi.fn(),
  transferOrcaProfileProjectMock: vi.fn(),
  hasOrcaProfileStateDatabaseMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    exit: appExitMock,
    quit: appQuitMock,
    relaunch: appRelaunchMock
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('../../tray/system-tray', () => ({
  destroySystemTray: destroySystemTrayMock
}))

vi.mock('../../startup/quit/app-relaunch', () => ({
  relaunchApp: relaunchAppMock
}))

vi.mock('../../orca-profiles/profile-index-store', () => ({
  createLocalOrcaProfile: createLocalOrcaProfileMock,
  getOrcaProfileListState: getOrcaProfileListStateMock,
  initializeNewOrcaProfileState: initializeNewOrcaProfileStateMock,
  setActiveOrcaProfile: setActiveOrcaProfileMock
}))

vi.mock('../../orca-profiles/new-profile-state', async (importOriginal) => ({
  ...(await importOriginal<typeof NewProfileStateModule>()),
  initializeNewOrcaProfileState: initializeNewOrcaProfileStateMock
}))

vi.mock('../../orca-profiles/profile-cloud-service', async (importOriginal) => ({
  ...(await importOriginal<typeof ProfileCloudService>()),
  createCloudLinkedOrcaProfile: createCloudLinkedOrcaProfileMock
}))

function makeStoreMock(flushPendingOrThrowAsync = vi.fn()) {
  const freezeWrites = vi.fn()
  const resumeMaintenance = vi.fn(async () => {})
  return {
    flushPendingOrThrowAsync,
    freezeWrites,
    resumeMaintenance,
    beginProfileMaintenance: vi.fn(async (options: unknown) => {
      await flushPendingOrThrowAsync(options)
      freezeWrites()
      return { resume: resumeMaintenance }
    }),
    getSettings: () => ({})
  }
}

vi.mock('../../orca-profiles/profile-project-transfer', () => ({
  transferOrcaProfileProject: transferOrcaProfileProjectMock
}))

vi.mock('../../orca-profiles/profile-storage-paths', async (importOriginal) => ({
  ...(await importOriginal<typeof ProfileStoragePaths>()),
  hasOrcaProfileStateDatabase: hasOrcaProfileStateDatabaseMock
}))

import { registerOrcaProfileHandlers } from './orca-profiles'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'

const ipcEvent = { sender: { isDestroyed: () => false, send: vi.fn() } }

describe('registerOrcaProfileHandlers', () => {
  beforeEach(() => {
    // Reinstall AppEnvironment per test after global beforeEach resets its fake.
    installFakeAppEnvironment({ getPath: () => '/tmp/orca-user-data' })
    vi.useFakeTimers()
    handlers.clear()
    ipcEvent.sender.send.mockClear()
    appExitMock.mockReset()
    appQuitMock.mockReset()
    appRelaunchMock.mockReset()
    relaunchAppMock.mockReset()
    relaunchAppMock.mockImplementation(() => appRelaunchMock())
    destroySystemTrayMock.mockReset()
    createLocalOrcaProfileMock.mockReset()
    createCloudLinkedOrcaProfileMock.mockReset()
    getOrcaProfileListStateMock.mockReset()
    initializeNewOrcaProfileStateMock.mockReset()
    setActiveOrcaProfileMock.mockReset()
    transferOrcaProfileProjectMock.mockReset()
    hasOrcaProfileStateDatabaseMock.mockReset().mockReturnValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('initializes the selected workspace for a newly created local profile', () => {
    const created = { profile: { id: 'local-work', name: 'Work' } }
    createLocalOrcaProfileMock.mockReturnValue(created)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Profile creation uses only the mocked store methods.
    registerOrcaProfileHandlers(makeStoreMock() as never)

    expect(handlers.get('orcaProfiles:createLocal')?.(ipcEvent, { name: 'Work' })).toBe(created)
    expect(initializeNewOrcaProfileStateMock).toHaveBeenCalledWith('local-work', undefined)
  })

  it('initializes Home for a newly created cloud-linked profile', async () => {
    const created = {
      status: 'created',
      auth: { activeProfileId: 'local-default' },
      activeProfileId: 'local-default',
      profiles: [],
      profile: { id: 'cloud-1' }
    }
    createCloudLinkedOrcaProfileMock.mockResolvedValue(created)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Profile creation uses only the mocked store methods.
    registerOrcaProfileHandlers(makeStoreMock() as never)

    await expect(
      handlers.get('orcaProfiles:createCloudLinked')?.(ipcEvent, { orgId: 'org-1', name: 'Work' })
    ).resolves.toBe(created)
    expect(initializeNewOrcaProfileStateMock).toHaveBeenCalledWith('cloud-1', undefined)
  })
})
