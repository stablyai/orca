import { describe, expect, it, vi } from 'vitest'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './persistence/loading-store/profile-state-maintenance-fixture'

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

describe('loading Store write-risk characterization', () => {
  it('awaits an accepted worker commit before freezing and rejects later writes', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const committed = maintenanceBarrier()
    const acknowledge = maintenanceBarrier()
    const writeDomains = authority.writeCompleteSerializedDomains.bind(authority)
    vi.spyOn(authority, 'writeCompleteSerializedDomains').mockImplementationOnce(
      async (replacements) => {
        await writeDomains(replacements)
        committed.resolve()
        await acknowledge.promise
      }
    )
    const close = vi.spyOn(authority, 'close')

    store.updateUI({ sidebarWidth: 712 })
    const writing = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    await committed.promise
    const frozen = store.freezeWritesAsync()
    await Promise.resolve()
    expect(close).not.toHaveBeenCalled()
    await expect(store.runDurableMutation(() => ({ value: undefined }))).rejects.toThrow(
      'finalized'
    )

    acknowledge.resolve()
    await writing
    await frozen
    expect(close).toHaveBeenCalledOnce()
    expect(readState().ui.sidebarWidth).toBe(712)
    store.updateUI({ sidebarWidth: 999 })
    await expect(store.flushPendingOrThrowAsync()).rejects.toThrow('finalized')
    expect(readState().ui.sidebarWidth).toBe(712)
  })

  it('keeps a rejected durable mutation in memory for a later unrelated flush', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const before = readState().sshPtyConsumerRecoveries
    const writeDomains = authority.writeCompleteSerializedDomains.bind(authority)
    const rejectedWrite = vi
      .spyOn(authority, 'writeCompleteSerializedDomains')
      .mockImplementationOnce(() =>
        writeDomains([{ domain: 'sshPtyConsumerRecoveries', payload: '{' }])
      )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      store.upsertSshPtyConsumerRecovery({
        targetId: 'ssh-1',
        clientInstanceId: 'client-1',
        serverBuildId: 'relay-build-1',
        clientGeneration: 3,
        ownerGeneration: 5,
        ownerLease: 'secret-owner-lease'
      })
    ).rejects.toMatchObject({ outcome: 'known-failure' })
    expect(readState().sshPtyConsumerRecoveries).toEqual(before)
    expect(store.getSshPtyConsumerRecovery('ssh-1')?.clientInstanceId).toBe('client-1')

    rejectedWrite.mockRestore()
    store.updateUI({ sidebarWidth: 713 })
    await store.flushPendingOrThrowAsync()
    expect(readState()).toMatchObject({
      ui: { sidebarWidth: 713 },
      sshPtyConsumerRecoveries: [expect.objectContaining({ clientInstanceId: 'client-1' })]
    })
  })
})
