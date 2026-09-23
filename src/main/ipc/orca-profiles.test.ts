import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProfileStoragePaths from '../orca-profiles/profile-storage-paths'

const {
  handlers,
  appExitMock,
  appQuitMock,
  appRelaunchMock,
  relaunchAppMock,
  destroySystemTrayMock,
  createLocalOrcaProfileMock,
  getOrcaProfileListStateMock,
  seedNewOrcaProfileTelemetryConsentMock,
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
  getOrcaProfileListStateMock: vi.fn(),
  seedNewOrcaProfileTelemetryConsentMock: vi.fn(),
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

vi.mock('../tray/system-tray', () => ({
  destroySystemTray: destroySystemTrayMock
}))

vi.mock('../app-relaunch', () => ({
  relaunchApp: relaunchAppMock
}))

vi.mock('../orca-profiles/profile-index-store', () => ({
  createLocalOrcaProfile: createLocalOrcaProfileMock,
  getOrcaProfileListState: getOrcaProfileListStateMock,
  seedNewOrcaProfileTelemetryConsent: seedNewOrcaProfileTelemetryConsentMock,
  setActiveOrcaProfile: setActiveOrcaProfileMock
}))

function makeStoreMock(flushPendingOrThrowAsync = vi.fn()): {
  flushPendingOrThrowAsync: typeof flushPendingOrThrowAsync
  freezeWrites: ReturnType<typeof vi.fn>
  getSettings: () => Record<string, never>
} {
  return { flushPendingOrThrowAsync, freezeWrites: vi.fn(), getSettings: () => ({}) }
}

vi.mock('../orca-profiles/profile-project-transfer', () => ({
  transferOrcaProfileProject: transferOrcaProfileProjectMock
}))

vi.mock('../orca-profiles/profile-storage-paths', async (importOriginal) => ({
  ...(await importOriginal<typeof ProfileStoragePaths>()),
  hasOrcaProfileStateDatabase: hasOrcaProfileStateDatabaseMock
}))

import { registerOrcaProfileHandlers } from './orca-profiles'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

describe('registerOrcaProfileHandlers', () => {
  beforeEach(() => {
    // Why the port and per-test: userData resolves through AppEnvironment now, and
    // the global setup's beforeEach reinstates its own fake before this runs.
    installFakeAppEnvironment({ getPath: () => '/tmp/orca-user-data' })
    vi.useFakeTimers()
    handlers.clear()
    appExitMock.mockReset()
    appQuitMock.mockReset()
    appRelaunchMock.mockReset()
    relaunchAppMock.mockReset()
    relaunchAppMock.mockImplementation(() => appRelaunchMock())
    destroySystemTrayMock.mockReset()
    createLocalOrcaProfileMock.mockReset()
    getOrcaProfileListStateMock.mockReset()
    seedNewOrcaProfileTelemetryConsentMock.mockReset()
    setActiveOrcaProfileMock.mockReset()
    transferOrcaProfileProjectMock.mockReset()
    hasOrcaProfileStateDatabaseMock.mockReset().mockReturnValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers list and create handlers', async () => {
    const listState = {
      activeProfileId: 'local-default',
      profiles: [{ id: 'local-default', name: 'Personal' }]
    }
    const createState = {
      ...listState,
      profile: { id: 'local-work', name: 'Work' }
    }
    getOrcaProfileListStateMock.mockReturnValue(listState)
    createLocalOrcaProfileMock.mockReturnValue(createState)

    registerOrcaProfileHandlers(makeStoreMock() as never)

    await expect(Promise.resolve(handlers.get('orcaProfiles:list')?.(null))).resolves.toEqual({
      ...listState,
      multiProfileUi: false
    })
    await expect(
      Promise.resolve(handlers.get('orcaProfiles:createLocal')?.(null, { name: 'Work' }))
    ).resolves.toBe(createState)
    expect(createLocalOrcaProfileMock).toHaveBeenCalledWith({ name: 'Work' })
  })

  it('reports multiProfileUi when the env flag is set', async () => {
    const previous = process.env.ORCA_MULTI_PROFILE_UI
    process.env.ORCA_MULTI_PROFILE_UI = '1'
    try {
      getOrcaProfileListStateMock.mockReturnValue({
        activeProfileId: 'local-default',
        profiles: []
      })
      registerOrcaProfileHandlers(makeStoreMock() as never)

      await expect(Promise.resolve(handlers.get('orcaProfiles:list')?.(null))).resolves.toEqual({
        activeProfileId: 'local-default',
        profiles: [],
        multiProfileUi: true
      })
    } finally {
      if (previous === undefined) {
        delete process.env.ORCA_MULTI_PROFILE_UI
      } else {
        process.env.ORCA_MULTI_PROFILE_UI = previous
      }
    }
  })

  it('marks the target profile active, flushes, and relaunches', async () => {
    const flush = vi.fn()
    const onBeforeRelaunch = vi.fn()
    getOrcaProfileListStateMock.mockReturnValue({
      activeProfileId: 'local-default',
      profiles: []
    })
    setActiveOrcaProfileMock.mockReturnValue({
      activeProfileId: 'local-work',
      profiles: []
    })
    registerOrcaProfileHandlers(makeStoreMock(flush) as never, { onBeforeRelaunch })

    const resultPromise = Promise.resolve(
      handlers.get('orcaProfiles:switch')?.(null, { profileId: 'local-work' })
    )

    await expect(resultPromise).resolves.toEqual({ status: 'relaunching' })
    expect(setActiveOrcaProfileMock).toHaveBeenCalledWith('local-work')
    expect(flush).toHaveBeenCalledOnce()
    expect(onBeforeRelaunch).toHaveBeenCalledOnce()
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
      setActiveOrcaProfileMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    expect(flush).toHaveBeenCalledBefore(onBeforeRelaunch)
    expect(appRelaunchMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(150)

    expect(appRelaunchMock).toHaveBeenCalledOnce()
    expect(relaunchAppMock).toHaveBeenCalledWith('profile-switch')
    // Why quit, not exit: before-quit/will-quit teardown (scrollback capture,
    // PTY kill, daemon checkpoints) must run on a profile switch.
    expect(appQuitMock).toHaveBeenCalledOnce()
    expect(appExitMock).not.toHaveBeenCalled()
  })

  it('does not mark a profile active when current profile flush fails', async () => {
    const flush = vi.fn(() => {
      throw new Error('flush_failed')
    })
    getOrcaProfileListStateMock.mockReturnValue({
      activeProfileId: 'local-default',
      profiles: []
    })
    registerOrcaProfileHandlers(makeStoreMock(flush) as never)

    await expect(
      Promise.resolve(handlers.get('orcaProfiles:switch')?.(null, { profileId: 'local-work' }))
    ).rejects.toThrow('flush_failed')

    expect(setActiveOrcaProfileMock).not.toHaveBeenCalled()
    expect(appRelaunchMock).not.toHaveBeenCalled()
  })

  it('does not switch profiles when persistence cannot reach quiescence', async () => {
    const flush = vi.fn(() => new Promise<void>(() => {}))
    const onBeforeRelaunch = vi.fn()
    getOrcaProfileListStateMock.mockReturnValue({
      activeProfileId: 'local-default',
      profiles: []
    })
    registerOrcaProfileHandlers(makeStoreMock(flush) as never, { onBeforeRelaunch })

    const switchProfile = Promise.resolve(
      handlers.get('orcaProfiles:switch')?.(null, { profileId: 'local-work' })
    )
    const rejection = expect(switchProfile).rejects.toThrow('orca_profile_persistence_timeout')
    await vi.advanceTimersByTimeAsync(20_000)
    await rejection

    expect(setActiveOrcaProfileMock).not.toHaveBeenCalled()
    expect(appRelaunchMock).not.toHaveBeenCalled()
    expect(onBeforeRelaunch).not.toHaveBeenCalled()
  })

  it('does not relaunch when switching to the active profile', async () => {
    getOrcaProfileListStateMock.mockReturnValue({
      activeProfileId: 'local-default',
      profiles: []
    })
    registerOrcaProfileHandlers(makeStoreMock() as never)

    await expect(
      Promise.resolve(handlers.get('orcaProfiles:switch')?.(null, { profileId: 'local-default' }))
    ).resolves.toEqual({ status: 'already-active' })

    expect(setActiveOrcaProfileMock).not.toHaveBeenCalled()
    expect(appRelaunchMock).not.toHaveBeenCalled()
  })

  it('rejects invalid profile ids', async () => {
    registerOrcaProfileHandlers(makeStoreMock() as never)

    await expect(
      Promise.resolve(handlers.get('orcaProfiles:switch')?.(null, { profileId: ' ' }))
    ).rejects.toThrow('invalid_orca_profile_id')
  })

  it('transfers projects between inactive profiles after flushing active state', async () => {
    const flush = vi.fn()
    const result = {
      status: 'transferred',
      mode: 'copy',
      sourceProfileId: 'personal',
      targetProfileId: 'work',
      sourceRepoId: 'repo-1',
      targetRepoId: 'repo-2',
      targetProjectId: 'repo:repo-2'
    }
    getOrcaProfileListStateMock.mockReturnValue({
      activeProfileId: 'personal',
      profiles: []
    })
    transferOrcaProfileProjectMock.mockReturnValue(result)
    registerOrcaProfileHandlers(makeStoreMock(flush) as never)

    await expect(
      Promise.resolve(
        handlers.get('orcaProfiles:transferProject')?.(null, {
          sourceProfileId: ' personal ',
          targetProfileId: ' work ',
          repoId: ' repo-1 ',
          mode: 'copy'
        })
      )
    ).resolves.toBe(result)

    expect(flush).toHaveBeenCalledOnce()
    expect(transferOrcaProfileProjectMock).toHaveBeenCalledWith(
      {
        sourceProfileId: 'personal',
        targetProfileId: 'work',
        repoId: 'repo-1',
        mode: 'copy'
      },
      '/tmp/orca-user-data'
    )
  })

  it('moves a project out of the active profile and relaunches into the target profile', async () => {
    const flush = vi.fn()
    const onBeforeRelaunch = vi.fn()
    const result = {
      status: 'transferred',
      mode: 'move',
      sourceProfileId: 'personal',
      targetProfileId: 'work',
      sourceRepoId: 'repo-1',
      targetRepoId: 'repo-1',
      targetProjectId: 'repo:repo-1'
    }
    getOrcaProfileListStateMock.mockReturnValue({
      activeProfileId: 'personal',
      profiles: []
    })
    transferOrcaProfileProjectMock.mockReturnValue(result)
    registerOrcaProfileHandlers(makeStoreMock(flush) as never, { onBeforeRelaunch })

    await expect(
      Promise.resolve(
        handlers.get('orcaProfiles:transferProject')?.(null, {
          sourceProfileId: 'personal',
          targetProfileId: 'work',
          repoId: 'repo-1',
          mode: 'move'
        })
      )
    ).resolves.toEqual({ ...result, willRelaunch: true })

    expect(onBeforeRelaunch).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledOnce()
    expect(transferOrcaProfileProjectMock).toHaveBeenCalledWith(
      {
        sourceProfileId: 'personal',
        targetProfileId: 'work',
        repoId: 'repo-1',
        mode: 'move'
      },
      '/tmp/orca-user-data'
    )
    expect(setActiveOrcaProfileMock).toHaveBeenCalledWith('work')
    expect(appRelaunchMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(150)

    expect(appRelaunchMock).toHaveBeenCalledOnce()
    expect(relaunchAppMock).toHaveBeenCalledWith('profile-transfer')
    expect(appQuitMock).toHaveBeenCalledOnce()
    expect(appExitMock).not.toHaveBeenCalled()
  })

  it('rejects transfers that would mutate the active target profile offline', async () => {
    getOrcaProfileListStateMock.mockReturnValue({
      activeProfileId: 'work',
      profiles: []
    })
    registerOrcaProfileHandlers(makeStoreMock() as never)

    await expect(
      Promise.resolve(
        handlers.get('orcaProfiles:transferProject')?.(null, {
          sourceProfileId: 'personal',
          targetProfileId: 'work',
          repoId: 'repo-1',
          mode: 'copy'
        })
      )
    ).rejects.toThrow('active_target_orca_profile_transfer_requires_relaunch')

    expect(transferOrcaProfileProjectMock).not.toHaveBeenCalled()
  })

  it('freezes a newly migrated source after transfer failure and reopens its current profile', async () => {
    const store = makeStoreMock()
    const onBeforeRelaunch = vi.fn()
    getOrcaProfileListStateMock.mockReturnValue({ activeProfileId: 'personal', profiles: [] })
    transferOrcaProfileProjectMock.mockImplementation(() => {
      hasOrcaProfileStateDatabaseMock.mockReturnValue(true)
      throw new Error('source commit interrupted')
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every Store operation exercised by these IPC handlers.
    registerOrcaProfileHandlers(store as never, { onBeforeRelaunch })

    await expect(
      Promise.resolve(
        handlers.get('orcaProfiles:transferProject')?.(null, {
          sourceProfileId: 'personal',
          targetProfileId: 'work',
          repoId: 'repo-1',
          mode: 'move'
        })
      )
    ).rejects.toThrow('source commit interrupted')

    expect(store.flushPendingOrThrowAsync).toHaveBeenCalledBefore(transferOrcaProfileProjectMock)
    expect(store.freezeWrites).toHaveBeenCalledOnce()
    expect(store.freezeWrites).toHaveBeenCalledBefore(onBeforeRelaunch)
    expect(setActiveOrcaProfileMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(150)
    expect(relaunchAppMock).toHaveBeenCalledWith('profile-transfer')
    expect(appQuitMock).toHaveBeenCalledOnce()
  })

  it('keeps an active JSON source writable after validation fails without a migration', async () => {
    const store = makeStoreMock()
    const onBeforeRelaunch = vi.fn()
    getOrcaProfileListStateMock.mockReturnValue({ activeProfileId: 'personal', profiles: [] })
    transferOrcaProfileProjectMock.mockImplementation(() => {
      throw new Error('unknown_source_repo')
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every Store operation exercised by these IPC handlers.
    registerOrcaProfileHandlers(store as never, { onBeforeRelaunch })

    await expect(
      Promise.resolve(
        handlers.get('orcaProfiles:transferProject')?.(null, {
          sourceProfileId: 'personal',
          targetProfileId: 'work',
          repoId: 'repo-1',
          mode: 'move'
        })
      )
    ).rejects.toThrow('unknown_source_repo')

    expect(store.freezeWrites).not.toHaveBeenCalled()
    expect(onBeforeRelaunch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(150)
    expect(relaunchAppMock).not.toHaveBeenCalled()
  })

  it.each([
    null,
    {},
    { sourceProfileId: 4 },
    {
      sourceProfileId: 'personal',
      targetProfileId: 'work',
      repoId: 'repo-1',
      mode: 'invalid'
    }
  ])('rejects malformed transfer arguments before disk work: %j', async (args) => {
    const store = makeStoreMock()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every Store operation exercised by these IPC handlers.
    registerOrcaProfileHandlers(store as never)
    await expect(
      Promise.resolve(handlers.get('orcaProfiles:transferProject')?.(null, args))
    ).rejects.toThrow('invalid_orca_profile_project_transfer')
    expect(store.flushPendingOrThrowAsync).not.toHaveBeenCalled()
    expect(transferOrcaProfileProjectMock).not.toHaveBeenCalled()
  })
})
