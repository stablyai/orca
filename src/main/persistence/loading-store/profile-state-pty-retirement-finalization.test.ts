import { describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import { retirePersistedStablePaneOwner } from '../../ipc/pty/pane/stable-owner'
import { TEST_LEAF_1 } from '../../persistence-session-fixtures'
import { ProfileStateWriterError } from '../profile-state/profile-state-writer-errors'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './profile-state-maintenance-fixture'
import type { Store } from './store'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const binding = {
  worktreeId: 'repo-local::/fixture/local',
  tabId: 'finalizing-retirement-tab',
  leafId: TEST_LEAF_1,
  ptyId: 'finalizing-retirement-pty',
  incarnationId: 'finalizing-retirement-incarnation'
}

function retire(store: Store, connectionId?: string) {
  return retirePersistedStablePaneOwner(
    store,
    { ...binding, persistedIncarnationId: binding.incarnationId },
    binding.worktreeId,
    connectionId
  )
}

function assertNewSnapshotsRefused(store: Store) {
  const session = store.getWorkspaceSession()
  expect(() => store.setWorkspaceSession(session)).toThrow('blocking new terminal snapshot work')
  expect(() => store.stageWorkspaceSessionBeforeUnload(session)).toThrow(
    'blocking new terminal snapshot work'
  )
}

describe.each([
  ['running', undefined],
  ['maintenance', undefined],
  ['freeze', undefined],
  ['final', undefined],
  ['running', 'retirement-ssh'],
  ['maintenance', 'retirement-ssh'],
  ['freeze', 'retirement-ssh'],
  ['final', 'retirement-ssh']
] as const)('admitted terminal retirement during %s on host %s', (kind, connectionId) => {
  const hostId = connectionId ? toSshExecutionHostId(connectionId) : undefined
  const persistedSession = (
    readState: Awaited<ReturnType<typeof createWorkerMaintenanceFixture>>['readState']
  ) => {
    const state = readState()
    return hostId ? state.workspaceSessionsByHostId[hostId] : state.workspaceSession
  }
  const stop = (store: Store) =>
    kind === 'maintenance'
      ? store.beginProfileMaintenance()
      : kind === 'freeze'
        ? store.freezeWritesAsync()
        : kind === 'final'
          ? store.flushFinalOrThrowAsync()
          : Promise.resolve()
  const assertSnapshotAdmission = (store: Store) => {
    if (kind !== 'running') {
      assertNewSnapshotsRefused(store)
    }
  }

  it('persists an accepted queued retirement while refusing new snapshots', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await store.persistPtyBinding(binding, hostId)
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    const write = authority.writeSerializedDomains.bind(authority)
    vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
      started.resolve()
      await release.promise
      await write(domains)
    })
    store.updateSettings({ theme: 'dark' })
    const previous = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    await started.promise
    const accepted = retire(store, connectionId).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    )
    const stopping = stop(store)
    assertSnapshotAdmission(store)
    release.resolve()
    await previous
    await stopping
    expect(await accepted).toEqual({ value: true })
    expect(persistedSession(readState).terminalLayoutsByTabId[binding.tabId]).toBeUndefined()
    assertSnapshotAdmission(store)
  })

  it('finishes a failed retirement rollback before closing its writer', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await store.persistPtyBinding(binding, hostId)
    const original = structuredClone(store.getWorkspaceSession(hostId))
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    const failure = new ProfileStateWriterError(
      'test-disk-failure',
      'retirement disk refused',
      'known-failure'
    )
    vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async () => {
      started.resolve()
      await release.promise
      throw failure
    })
    const rejected = retire(store, connectionId).catch((error: unknown) => error)
    await started.promise
    expect(store.getWorkspaceSession(hostId).terminalLayoutsByTabId[binding.tabId]).toBeUndefined()
    store.getWorkspaceSession(hostId).activeTabId = 'newer-active-tab'
    const stopping = stop(store)
    assertSnapshotAdmission(store)
    release.resolve()
    await stopping
    expect(await rejected).toBe(failure)
    expect(store.getWorkspaceSession(hostId)).toEqual({
      ...original,
      activeTabId: 'newer-active-tab'
    })
    expect(persistedSession(readState).terminalLayoutsByTabId[binding.tabId]).toEqual(
      original.terminalLayoutsByTabId[binding.tabId]
    )
    assertSnapshotAdmission(store)
  })
})

describe.each(['mutate', 'rollback'] as const)('admitted %s scope', (phase) => {
  it('preserves durable state and refuses later saves after a callback partially mutates then throws', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const original = readState()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('callback failed')
    if (phase === 'rollback') {
      vi.spyOn(authority, 'writeSerializedDomains').mockRejectedValueOnce(new Error('disk refused'))
    }
    await expect(
      store.runDurableMutation(() => {
        store.updateSettings({ theme: 'dark' })
        if (phase === 'mutate') {
          throw failure
        }
        return {
          value: undefined,
          rollback: () => {
            throw failure
          }
        }
      })
    ).rejects.toBe(failure)
    assertNewSnapshotsRefused(store)
    await expect(store.runDurableMutation(() => ({ value: undefined }))).rejects.toThrow(
      'finalized'
    )
    await expect(store.flushFinalOrThrowAsync()).rejects.toBe(failure)
    expect(readState()).toEqual(original)
  })
})

it('rejects an already admitted final flush after a queued callback partially mutates then throws', async () => {
  const { store, authority, readState } = await createWorkerMaintenanceFixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const started = maintenanceBarrier()
  const release = maintenanceBarrier()
  const write = authority.writeSerializedDomains.bind(authority)
  vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
    started.resolve()
    await release.promise
    await write(domains)
  })
  store.updateSettings({ theme: 'dark' })
  const previous = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
  await started.promise
  const failure = new Error('partial edit failed')
  const mutation = store.runDurableMutation(() => {
    store.updateSettings({ theme: 'light' })
    throw failure
  })
  const rejectedMutation = expect(mutation).rejects.toBe(failure)
  const rejectedFinal = expect(store.flushFinalOrThrowAsync()).rejects.toBe(failure)
  release.resolve()
  await Promise.all([previous, rejectedMutation, rejectedFinal])
  expect(readState().settings.theme).toBe('dark')
})
