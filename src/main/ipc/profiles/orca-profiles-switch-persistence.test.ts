import 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from '../../persistence/loading-store/profile-writing/profile-state-maintenance-fixture'
import { registerOrcaProfileHandlers } from './orca-profiles'
import { OrcaAccountService } from '../../orca-profiles/orca-account-service'

const orcaAccount = new OrcaAccountService({ openBrowser: async () => {} })

const { handlers, select, prepare } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => Promise<unknown>>(),
  prepare: vi.fn(),
  select: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => Promise<unknown>) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('../../startup/quit/app-relaunch', () => ({
  prepareAppRelaunch: prepare,
  relaunchAppAndQuit: vi.fn(),
  runBeforeRelaunchCleanup: async (cleanup?: () => Promise<void>) => cleanup?.()
}))
vi.mock('../../orca-profiles/profile-index-store', () => ({
  getOrcaProfileListState: () => ({
    activeProfileId: 'source',
    profiles: [{ id: 'source' }, { id: 'target' }]
  }),
  setActiveOrcaProfile: select,
  createLocalOrcaProfile: vi.fn()
}))

vi.mock('../../orca-profiles/storage/new-profile-state', () => ({
  initializeNewOrcaProfileState: vi.fn()
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

afterEach(() => {
  vi.useRealTimers()
  select.mockClear()
})

describe('plain profile switch persistence', () => {
  it('preserves shutdown changes when quit starts during the switch checkpoint', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    await store.flushPendingOrThrowAsync()
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    const hold = async (write: () => Promise<void>) => {
      started.resolve()
      await release.promise
      await write()
    }
    const selective = authority.writeSerializedDomains.bind(authority)
    const complete = authority.writeCompleteSerializedDomains.bind(authority)
    vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce((domains) =>
      hold(() => selective(domains))
    )
    vi.spyOn(authority, 'writeCompleteSerializedDomains').mockImplementationOnce((domains) =>
      hold(() => complete(domains))
    )
    store.updateSettings({ theme: 'dark' })
    registerOrcaProfileHandlers(store, orcaAccount)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const switching = handlers
      .get('orcaProfiles:switch')?.(
        { sender: { isDestroyed: () => false, send: vi.fn() } },
        { profileId: 'target' }
      )
      .catch((error: unknown) => error)
    await started.promise
    store.getWorkspaceSession().activeTabId = 'last-tab'
    const final = store.flushFinalOrThrowAsync()
    release.resolve()
    await final
    await expect(switching).resolves.toEqual({ status: 'relaunching' })
    expect(readState()).toMatchObject({
      settings: { theme: 'dark' },
      workspaceSession: { activeTabId: 'last-tab' }
    })
  })

  it('leaves the startup profile unchanged if quit cancels an AppImage switch during preparation', async () => {
    const { store } = await createWorkerMaintenanceFixture()
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    const controller = new AbortController()
    prepare.mockResolvedValueOnce({ signal: controller.signal, cancel: vi.fn() })
    registerOrcaProfileHandlers(store, orcaAccount, {
      onBeforeRelaunch: async () => {
        started.resolve()
        await release.promise
      }
    })
    const sender = { isDestroyed: () => false, send: vi.fn() }
    const switching = handlers.get('orcaProfiles:switch')?.({ sender }, { profileId: 'target' })
    const rejected = expect(switching).rejects.toThrow('Orca restart was canceled.')
    await started.promise
    controller.abort(new Error('Orca restart was canceled.'))
    release.resolve()
    await rejected
    expect(select).not.toHaveBeenCalled()
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('rejects an unknown profile before arming restart', async () => {
    const { store } = await createWorkerMaintenanceFixture()
    registerOrcaProfileHandlers(store, orcaAccount)
    prepare.mockClear()
    const switchProfile = handlers.get('orcaProfiles:switch')
    await expect(switchProfile?.({}, { profileId: 'missing' })).rejects.toThrow(
      'unknown_orca_profile'
    )
    expect(prepare).not.toHaveBeenCalled()
  })
})
