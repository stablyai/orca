import 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from '../../persistence/loading-store/profile-state-maintenance-fixture'
import { registerOrcaProfileHandlers } from './orca-profiles'

const { handlers, quit, select } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => Promise<unknown>>(),
  quit: vi.fn(),
  select: vi.fn()
}))
vi.mock('electron', () => ({
  app: { quit },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => Promise<unknown>) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('../../startup/quit/app-relaunch', () => ({ relaunchApp: vi.fn() }))
vi.mock('../../orca-profiles/profile-index-store', () => ({
  getOrcaProfileListState: () => ({ activeProfileId: 'source', profiles: [] }),
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
    registerOrcaProfileHandlers(store)
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
})
