import { describe, expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'
import { Store } from './store'
import { setSecretStore } from '../../../shared/secret-store'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const recovery = {
  distro: 'Ubuntu',
  relayBuildId: '0.1.0+build',
  clientInstanceId: 'client',
  clientGeneration: 1,
  ownerGeneration: 1,
  ownerLease: 'c5f48e88-0dbe-4894-90a2-876c0a3c0d8b'
}

function installSecretStore(available = true) {
  setSecretStore({
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`sealed:${value}`),
    decryptString: (value) => value.toString().slice('sealed:'.length),
    describeProtectionGap: () => null
  })
}

describe('durable guest terminal owner recovery', () => {
  it('reserves writes before mutation and fences removal by consumer identity', async () => {
    installSecretStore()
    const { store, authority, readState } = await fixture()
    const gate = authority.pause()
    store.updateSettings({ theme: 'dark' })
    const flush = store.flushPendingOrThrowAsync()
    await gate.started.promise
    const first = store.upsertWslPtyConsumerRecovery(recovery)
    const second = store.upsertWslPtyConsumerRecovery({
      ...recovery,
      clientInstanceId: 'new-owner'
    })
    const staleRemoval = store.removeWslPtyConsumerRecovery(recovery, 'client')
    expect(store.getWslPtyConsumerRecovery(recovery)).toBeNull()
    gate.finish.resolve()
    await Promise.all([flush, first, second, staleRemoval])
    expect(store.getWslPtyConsumerRecovery(recovery)?.clientInstanceId).toBe('new-owner')
    expect(readState().wslPtyConsumerRecoveries).toHaveLength(1)
    expect(
      authority.captures.flat().filter((row) => row.domain === 'wslPtyConsumerRecoveries')
    ).toHaveLength(2)
  })

  it('retains separate leases for old builds and other distros', async () => {
    installSecretStore()
    const { store, readState } = await fixture()
    const newer = { ...recovery, relayBuildId: 'new-build' }
    const debian = { ...recovery, distro: 'Debian' }
    await store.upsertWslPtyConsumerRecovery(recovery)
    await store.upsertWslPtyConsumerRecovery(newer)
    await store.upsertWslPtyConsumerRecovery(debian)
    await store.removeWslPtyConsumerRecovery(newer, 'client')
    expect(store.getWslPtyConsumerRecovery(recovery)).toEqual(recovery)
    expect(store.getWslPtyConsumerRecovery(debian)).toEqual(debian)
    expect(store.getWslPtyConsumerRecovery(newer)).toBeNull()
    expect(readState().wslPtyConsumerRecoveries).toHaveLength(2)
  })

  it('encrypts both selective and final writes and restores the lease after restart', async () => {
    installSecretStore()
    const { store, readState } = await fixture()
    await store.upsertWslPtyConsumerRecovery(recovery)
    expect(JSON.stringify(readState())).not.toContain(recovery.ownerLease)
    await store.flushPendingOrThrowAsync()
    const serialized = JSON.stringify(readState())
    expect(serialized).not.toContain(recovery.ownerLease)
    const loaded = new Store({ serializedState: serialized })
    expect(loaded.getWslPtyConsumerRecovery(recovery)).toEqual(recovery)
    loaded.freezeWrites()
  })

  it('refuses to replace an unreadable owner lease with a new identity', async () => {
    installSecretStore()
    const { store, readState } = await fixture()
    await store.upsertWslPtyConsumerRecovery(recovery)
    installSecretStore(false)
    const loaded = new Store({ serializedState: JSON.stringify(readState()) })
    expect(() => loaded.getWslPtyConsumerRecovery(recovery)).toThrow('secrets are locked')
    loaded.freezeWrites()
    installSecretStore()
  })

  it('does not acknowledge a write that the authority refused', async () => {
    installSecretStore()
    const { store, authority, readState } = await fixture()
    await store.upsertWslPtyConsumerRecovery(recovery)
    const gate = authority.pause()
    const removal = expect(store.removeWslPtyConsumerRecovery(recovery, 'client')).rejects.toThrow(
      'disk refused'
    )
    await gate.started.promise
    gate.finish.reject(new Error('disk refused'))
    await removal
    expect(readState().wslPtyConsumerRecoveries).toHaveLength(1)
    await store.removeWslPtyConsumerRecovery(recovery, 'client')
    expect(readState().wslPtyConsumerRecoveries).toEqual([])
  })
})
