import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from '../persistence/loading-store/profile-state-maintenance-fixture'
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
vi.mock('../app-relaunch', () => ({ relaunchApp: vi.fn() }))
vi.mock('../orca-profiles/profile-index-store', () => ({
  getOrcaProfileListState: () => ({ activeProfileId: 'source', profiles: [] }),
  setActiveOrcaProfile: select,
  createLocalOrcaProfile: vi.fn(),
  seedNewOrcaProfileTelemetryConsent: vi.fn()
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

describe('plain profile switch persistence', () => {
  it('preserves shutdown changes when quit starts during the switch checkpoint', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    store.upsertSshRemotePtyLease({ targetId: 'remote', ptyId: 'pty', state: 'attached' })
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
    store.markSshRemotePtyLeasesForShutdown('remote', 'detached')
    const final = store.flushFinalOrThrowAsync()
    release.resolve()
    await final
    await expect(switching).resolves.toEqual({ status: 'relaunching' })
    expect(readState()).toMatchObject({
      settings: { theme: 'dark' },
      sshRemotePtyLeases: [expect.objectContaining({ state: 'detached' })]
    })
  })

  it('admits pre-relaunch writes and includes SSH detach in the final source checkpoint', async () => {
    const { store, readState, dataFile } = await createWorkerMaintenanceFixture()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.upsertSshRemotePtyLease({ targetId: 'remote', ptyId: 'pty', state: 'attached' })
    await store.flushPendingOrThrowAsync()
    const cleanupSaved = vi.fn()
    let final: Promise<void> | undefined
    quit.mockImplementation(() => {
      store.markSshRemotePtyLeasesForShutdown('remote', 'detached')
      final = store.flushFinalOrThrowAsync()
    })
    registerOrcaProfileHandlers(store, {
      onBeforeRelaunch: async () => {
        store.updateSettings({ theme: 'light' })
        await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
        cleanupSaved()
      }
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const switchProfile = handlers.get('orcaProfiles:switch')
    expect(switchProfile).toBeDefined()
    await switchProfile?.(
      { sender: { isDestroyed: () => false, send: vi.fn() } },
      { profileId: 'target' }
    )
    await vi.advanceTimersByTimeAsync(150)
    expect(final).toBeDefined()
    await final
    expect(select).toHaveBeenCalledWith('target')
    expect(cleanupSaved).toHaveBeenCalledOnce()
    expect(readState()).toMatchObject({
      settings: { theme: 'light' },
      sshRemotePtyLeases: [expect.objectContaining({ state: 'detached' })]
    })
    expect(existsSync(dataFile)).toBe(false)
  })
})
