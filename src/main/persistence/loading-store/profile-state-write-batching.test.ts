import { describe, expect, it, vi } from 'vitest'
import { deferred, fixture } from './profile-state-delayed-authority-fixture'
import { StateSerializationSecretHandlingOperations } from './state-serialization-secret-handling'
import * as composition from './store-domain-composition'
import type { StoreRuntimeState } from './store-runtime-state'
import { ProfileStateRevisionConflictError } from '../profile-state/profile-state-document-validation'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

async function snapshotFixture() {
  let captured: StoreRuntimeState | undefined
  const createDomains = composition.createStoreDomains
  vi.spyOn(composition, 'createStoreDomains').mockImplementationOnce((runtime) => {
    captured = runtime
    return createDomains(runtime)
  })
  const state = await fixture()
  if (!captured) {
    throw new Error('Store runtime was not initialized')
  }
  return { ...state, runtime: captured }
}

describe('queued worker snapshot batching', () => {
  it('captures getter-only edits in a flush requested after the preceding capture started', async () => {
    const { store, authority, readState } = await fixture()
    const fullCapture = vi.spyOn(
      StateSerializationSecretHandlingOperations.prototype,
      'buildStateToSave'
    )
    const firstGate = authority.pause()
    store.updateSettings({ theme: 'dark' })
    const first = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    await firstGate.started.promise
    store.getWorkspaceSession().activeTabId = 'getter-only-edit'
    const second = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    firstGate.finish.resolve()
    await Promise.all([first, second])
    expect(readState().workspaceSession.activeTabId).toBe('getter-only-edit')
    expect(fullCapture).toHaveBeenCalledOnce()
  })

  it('upgrades a queued debounce to capture an explicit getter-only flush', async () => {
    const { store, authority, readState } = await fixture()
    const gate = authority.pause()
    vi.useFakeTimers()
    try {
      const first = store.runDurableMutation(() => {
        store.updateSettings({ theme: 'dark' })
        return { value: undefined }
      })
      await gate.started.promise
      await vi.advanceTimersByTimeAsync(1_000)
      store.getWorkspaceSession().activeTabId = 'explicit-edit'
      const explicit = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      gate.finish.resolve()
      await Promise.all([first, explicit])
      expect(readState().workspaceSession.activeTabId).toBe('explicit-edit')
    } finally {
      gate.finish.resolve()
      vi.useRealTimers()
    }
  })

  it('keeps a later flush ordered after an intervening durable mutation', async () => {
    const { store, authority, readState } = await fixture()
    const gate = authority.pause()
    store.updateSettings({ theme: 'dark' })
    const first = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    await gate.started.promise
    const before = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    const mutation = store.runDurableMutation(() => {
      store.updateSettings({ theme: 'light' })
      return { value: undefined }
    })
    const after = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    const verifyAfter = after.then(() => expect(readState().settings.theme).toBe('light'))
    gate.finish.resolve()
    await Promise.all([first, before, mutation, verifyAfter])
  })

  it('shares a queued write failure with its waiters and allows a fresh retry', async () => {
    const { store, authority, readState } = await fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const gate = authority.pause()
    store.updateSettings({ theme: 'dark' })
    const first = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    await gate.started.promise
    store.updateSettings({ theme: 'light' })
    const failed = [
      store.flushPendingOrThrowAsync({ drainToStableGeneration: false }),
      store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    ].map((waiter) => expect(waiter).rejects.toThrow('disk refused'))
    vi.spyOn(authority, 'writeSerializedDomains').mockRejectedValueOnce(new Error('disk refused'))
    gate.finish.resolve()
    await Promise.all([first, ...failed])
    await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    expect(readState().settings.theme).toBe('light')
  })

  it('checks the disk revision for a clean batch and rejects every waiter on conflict', async () => {
    const { store, authority } = await fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const conflict = new ProfileStateRevisionConflictError(1, 2)
    const revisionCheck = vi
      .spyOn(authority, 'assertCurrentRevision')
      .mockRejectedValueOnce(conflict)
    const waiters = [
      store.flushPendingOrThrowAsync({ drainToStableGeneration: false }),
      store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    ]
    await Promise.all(waiters.map((waiter) => expect(waiter).rejects.toBe(conflict)))
    expect(revisionCheck).toHaveBeenCalledOnce()
  })

  it('waits for snapshot files admitted by a later member of the queued batch', async () => {
    const { store, authority, readState, runtime } = await snapshotFixture()
    const gate = authority.pause()
    store.updateSettings({ theme: 'dark' })
    const first = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    await gate.started.promise
    const second = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    const snapshot = deferred<void>()
    runtime.pendingSnapshotFileWork = snapshot.promise
    store.updateSettings({ theme: 'light' })
    const third = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    try {
      gate.finish.resolve()
      await first
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(authority.captures).toHaveLength(1)
    } finally {
      snapshot.resolve()
      runtime.pendingSnapshotFileWork = null
      await Promise.all([second, third])
    }
    expect(readState().settings.theme).toBe('light')
  })

  it('discards a queued batch when its predecessor dependency rejects', async () => {
    const { store, readState, runtime } = await snapshotFixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    runtime.pendingSnapshotFileWork = Promise.reject(new Error('snapshot preparation failed'))
    const waiters = [
      store.flushPendingOrThrowAsync({ drainToStableGeneration: false }),
      store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    ]
    await Promise.all(
      waiters.map((waiter) => expect(waiter).rejects.toThrow('snapshot preparation failed'))
    )
    runtime.pendingSnapshotFileWork = null
    store.updateSettings({ theme: 'light' })
    await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    expect(readState().settings.theme).toBe('light')
  })
})
