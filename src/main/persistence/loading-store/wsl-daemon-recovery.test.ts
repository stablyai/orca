import { describe, expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'
import { Store } from './store'
import {
  normalizeWslDaemonRecovery,
  type WslDaemonRecovery
} from '../../../shared/wsl-daemon-recovery'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const recovery: WslDaemonRecovery = {
  kind: 'daemon',
  distro: 'Ubuntu',
  relayBuildId: 'profile-user-runtime-daemon-hash',
  endpoint: {
    distro: 'Ubuntu',
    distributionId: 'registration-id',
    userName: 'alice',
    userId: '1000',
    home: '/home/alice',
    runtime: '/home/alice/.orca/runtime/bun',
    entry: '/home/alice/.orca/daemon/daemon.js',
    envBinary: '/usr/bin/env',
    socket: '/home/alice/.orca/profile/control.sock',
    tokenPath: '/home/alice/.orca/profile/control.token',
    serverBuildId: 'daemon-build'
  }
}

describe('persisted guest daemon endpoint identity', () => {
  it('roundtrips optional owner protocol metadata while preserving strict endpoint validation', () => {
    const versioned = { ...recovery, endpoint: { ...recovery.endpoint, protocolVersion: 36 } }
    const loaded = new Store({
      serializedState: JSON.stringify({ wslPtyConsumerRecoveries: [versioned] })
    })
    expect(loaded.getWslDaemonRecovery(recovery)).toEqual(versioned)
    expect(normalizeWslDaemonRecovery(recovery)).toEqual(recovery)
    for (const protocolVersion of [0, -1, 1.5, '36', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        normalizeWslDaemonRecovery({
          ...recovery,
          endpoint: { ...recovery.endpoint, protocolVersion }
        })
      ).toBeNull()
    }
    expect(
      normalizeWslDaemonRecovery({
        ...versioned,
        endpoint: { ...versioned.endpoint, token: 'secret' }
      })
    ).toBeNull()
    loaded.freezeWrites()
  })

  it('roundtrips JSON without copying any guest authentication token', () => {
    const loaded = new Store({
      serializedState: JSON.stringify({ wslPtyConsumerRecoveries: [recovery] })
    })
    expect(loaded.getWslDaemonRecovery(recovery)).toEqual(recovery)
    expect(loaded.getWslPtyConsumerRecovery(recovery)).toBeNull()
    const records = loaded.listWslDaemonRecoveries()
    records[0]!.endpoint.userName = 'mutated-copy'
    expect(loaded.getWslDaemonRecovery(recovery)?.endpoint.userName).toBe('alice')
    loaded.freezeWrites()
  })

  it('selectively persists and reloads the confirmed endpoint with real SQLite', async () => {
    const { store, authority, readState } = await fixture()
    const gate = authority.pause()
    let acknowledged = false
    const write = store.upsertWslDaemonRecovery(recovery).then(() => {
      acknowledged = true
    })
    await gate.started.promise
    expect(acknowledged).toBe(false)
    expect(readState().wslPtyConsumerRecoveries ?? []).toEqual([])
    gate.finish.resolve()
    await write
    expect(authority.captures.flat().map((row) => row.domain)).toEqual(['wslPtyConsumerRecoveries'])
    expect(readState().wslPtyConsumerRecoveries).toEqual([recovery])
    const loaded = new Store({ serializedState: JSON.stringify(readState()) })
    expect(loaded.listWslDaemonRecoveries()).toEqual([recovery])
    loaded.freezeWrites()
  })

  it('isolates profiles and preserves distinct captured users/build owners', async () => {
    const first = await fixture()
    const second = await fixture()
    const bob: WslDaemonRecovery = {
      ...recovery,
      relayBuildId: 'bob-owner',
      endpoint: { ...recovery.endpoint, userName: 'bob', userId: '1001', home: '/home/bob' }
    }
    await first.store.upsertWslDaemonRecovery(recovery)
    await first.store.upsertWslDaemonRecovery(bob)
    expect(first.store.listWslDaemonRecoveries()).toHaveLength(2)
    expect(second.store.listWslDaemonRecoveries()).toEqual([])
    expect(second.readState().wslPtyConsumerRecoveries ?? []).toEqual([])
  })

  it.each([
    { ...recovery, endpoint: { ...recovery.endpoint, token: 'must-not-persist' } },
    { ...recovery, endpoint: { ...recovery.endpoint, userId: 'unknown' } },
    { ...recovery, endpoint: { ...recovery.endpoint, socket: '/home/alice/../bob/socket' } },
    { ...recovery, endpoint: { ...recovery.endpoint, tokenPath: 'relative' } },
    { ...recovery, endpoint: { ...recovery.endpoint, distro: 'Debian' } },
    { ...recovery, endpoint: { ...recovery.endpoint, entry: undefined } }
  ])('rejects an invalid or secret-bearing record %#', (invalid) => {
    expect(normalizeWslDaemonRecovery(invalid)).toBeNull()
    const loaded = new Store({
      serializedState: JSON.stringify({ wslPtyConsumerRecoveries: [invalid] })
    })
    expect(loaded.listWslDaemonRecoveries()).toEqual([])
    loaded.freezeWrites()
  })

  it('refuses to retarget a retained owner to another user', async () => {
    const { store, readState } = await fixture()
    await store.upsertWslDaemonRecovery(recovery)
    await expect(
      store.upsertWslDaemonRecovery({
        ...recovery,
        endpoint: { ...recovery.endpoint, userName: 'bob' }
      })
    ).rejects.toThrow('owner identity cannot change')
    expect(readState().wslPtyConsumerRecoveries).toEqual([recovery])
    await store.upsertWslDaemonRecovery({ ...recovery, relayBuildId: 'another-owner' })
    expect(store.listWslDaemonRecoveries()).toHaveLength(2)
  })

  it('does not acknowledge a refused disk write', async () => {
    const { store, authority, readState } = await fixture()
    const gate = authority.pause()
    const write = expect(store.upsertWslDaemonRecovery(recovery)).rejects.toThrow('disk refused')
    await gate.started.promise
    gate.finish.reject(new Error('disk refused'))
    await write
    expect(store.getWslDaemonRecovery(recovery)).toBeNull()
    expect(readState().wslPtyConsumerRecoveries ?? []).toEqual([])
  })
})

const oldIncarnation = {
  pid: 42,
  startedAtMs: 100,
  launchNonce: 'old',
  linuxStartTicks: '123',
  bootId: 'boot'
}
const newIncarnation = { ...oldIncarnation, pid: 43, launchNonce: 'new', linuxStartTicks: '456' }

it('admits incarnation changes only against the expected prior while keeping endpoint immutable', async () => {
  const { store, readState } = await fixture()
  await store.upsertWslDaemonRecovery(recovery)
  await store.upsertWslDaemonRecovery({ ...recovery, incarnation: oldIncarnation }, null)
  await expect(
    store.upsertWslDaemonRecovery({ ...recovery, incarnation: newIncarnation }, null)
  ).rejects.toThrow('admission changed')
  await expect(
    store.upsertWslDaemonRecovery(
      {
        ...recovery,
        endpoint: { ...recovery.endpoint, socket: '/other' },
        incarnation: newIncarnation
      },
      oldIncarnation
    )
  ).rejects.toThrow('owner identity cannot change')
  await store.upsertWslDaemonRecovery({ ...recovery, incarnation: newIncarnation }, oldIncarnation)
  expect(readState().wslPtyConsumerRecoveries).toEqual([
    { ...recovery, incarnation: newIncarnation }
  ])
})
it('rolls back refused incarnation admission without losing the prior durable owner', async () => {
  const { store, authority, readState } = await fixture()
  await store.upsertWslDaemonRecovery({ ...recovery, incarnation: oldIncarnation })
  const gate = authority.pause()
  const rejected = expect(
    store.upsertWslDaemonRecovery({ ...recovery, incarnation: newIncarnation }, oldIncarnation)
  ).rejects.toThrow('disk refused')
  await gate.started.promise
  expect(readState().wslPtyConsumerRecoveries).toEqual([
    { ...recovery, incarnation: oldIncarnation }
  ])
  gate.finish.reject(new Error('disk refused'))
  await rejected
  expect(store.getWslDaemonRecovery(recovery)?.incarnation).toEqual(oldIncarnation)
})

it('admits equivalent protocol metadata without changing the persisted owner identity', async () => {
  const { store } = await fixture()
  await store.upsertWslDaemonRecovery(recovery)
  const versioned = { ...recovery, endpoint: { ...recovery.endpoint, protocolVersion: 36 } }
  await store.upsertWslDaemonRecovery(versioned)
  expect(store.getWslDaemonRecovery(recovery)).toEqual(recovery)
  await expect(
    store.upsertWslDaemonRecovery({
      ...versioned,
      endpoint: { ...versioned.endpoint, protocolVersion: 37 }
    })
  ).rejects.toThrow('cannot change')
  await expect(
    store.upsertWslDaemonRecovery({
      ...versioned,
      endpoint: { ...versioned.endpoint, userName: 'bob' }
    })
  ).rejects.toThrow('cannot change')
})
