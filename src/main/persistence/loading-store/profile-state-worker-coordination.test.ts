import { describe, expect, it, vi } from 'vitest'
import { ProfileStateWriterError } from '../profile-state/profile-state-writer-errors'
import { fixture } from './profile-state-delayed-authority-fixture'
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

describe('worker-owned Store writes', () => {
  it('consumes the debounce timer and avoids full checkpoints after a selective durable write', async () => {
    const { store, authority, readState } = await fixture()
    const full = vi.spyOn(authority, 'writeCompleteSerializedDomains')
    const selective = vi.spyOn(authority, 'writeSerializedDomains')
    vi.useFakeTimers()
    try {
      await store.runDurableMutation(() => {
        store.updateSettings({ theme: 'dark' })
        return { value: undefined }
      })
      await vi.advanceTimersByTimeAsync(6_000)
      await store.waitForPendingWrite()
      expect(selective).toHaveBeenCalledOnce()
      expect(full).not.toHaveBeenCalled()
      expect(readState().settings.theme).toBe('dark')
    } finally {
      vi.useRealTimers()
    }
  })

  it('still captures direct durable mutations that do not identify dirty domains', async () => {
    const { store, readState } = await fixture()
    await store.runDurableMutation(() => {
      store.getWorkspaceSession().activeTabId = 'direct-mutation'
      return { value: undefined }
    })
    expect(readState().workspaceSession.activeTabId).toBe('direct-mutation')
  })

  it('skips a debounce callback already queued behind the write that consumed its changes', async () => {
    const { store, authority } = await fixture()
    const full = vi.spyOn(authority, 'writeCompleteSerializedDomains')
    const gate = authority.pause()
    vi.useFakeTimers()
    try {
      const durable = store.runDurableMutation(() => {
        store.updateSettings({ theme: 'dark' })
        return { value: undefined }
      })
      await gate.started.promise
      await vi.advanceTimersByTimeAsync(1_000)
      gate.finish.resolve()
      await durable
      await store.waitForPendingWrite()
      expect(full).not.toHaveBeenCalled()
    } finally {
      gate.finish.resolve()
      vi.useRealTimers()
    }
  })

  it('handles a rejected debounced save and retains it for an explicit retry', async () => {
    const { store, authority, readState } = await fixture()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const gate = authority.pause()
    vi.useFakeTimers()
    try {
      store.updateSettings({ theme: 'dark' })
      await vi.advanceTimersByTimeAsync(1000)
      await gate.started.promise
      gate.finish.reject(new Error('disk refused'))
      await store.waitForPendingWrite()
      expect(log).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
    await store.flushPendingOrThrowAsync()
    expect(readState().settings.theme).toBe('dark')
  })

  it('refuses an export when serialization invalidates its full checkpoint', async () => {
    const { store, authority, readState } = await fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const publish = vi.spyOn(authority, 'writeLatestJsonExport')
    const session = store.getWorkspaceSession()
    Object.defineProperty(session, 'toJSON', {
      configurable: true,
      value: () => {
        store.updateSettings({ theme: 'light' })
        return { ...session }
      }
    })
    try {
      await expect(store.writeLatestProfileStateJsonExportAsync()).rejects.toThrow(
        'changed while preparing its export'
      )
      expect(publish).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(session, 'toJSON')
    }
    await store.writeLatestProfileStateJsonExportAsync()
    expect(readState().settings.theme).toBe('light')
    expect(publish).toHaveBeenCalledOnce()
  })

  it('retains a newer edit after an older write is acknowledged', async () => {
    const { store, authority, readState } = await fixture()
    const gate = authority.pause()
    store.updateSettings({ theme: 'dark' })
    const first = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    await gate.started.promise
    store.updateSettings({ theme: 'light' })
    gate.finish.resolve()
    await first
    expect(readState().settings.theme).toBe('dark')
    await store.flushPendingOrThrowAsync()
    expect(readState().settings.theme).toBe('light')
  })

  it('merges a failed older write with dirty state added while it was in flight', async () => {
    const { store, authority, readState } = await fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const gate = authority.pause()
    store.updateSettings({ theme: 'dark' })
    const first = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    const rejected = expect(first).rejects.toThrow('disk refused')
    await gate.started.promise
    store.getWorkspaceSession().activeTabId = 'newer-tab'
    store.setWorkspaceSession(store.getWorkspaceSession())
    gate.finish.reject(new Error('disk refused'))
    await rejected
    await store.flushPendingOrThrowAsync()
    expect(readState()).toMatchObject({
      settings: { theme: 'dark' },
      workspaceSession: { activeTabId: 'newer-tab' }
    })
  })

  it('captures a full checkpoint after an older save even without a new generation', async () => {
    const { store, authority, readState } = await fixture()
    const gate = authority.pause()
    store.updateSettings({ theme: 'dark' })
    const first = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    await gate.started.promise
    store.getWorkspaceSession().activeTabId = 'getter-only-tab'
    const final = store.flushAsync()
    gate.finish.resolve()
    await first
    await final
    expect(readState().workspaceSession.activeTabId).toBe('getter-only-tab')
    expect(authority.captures.at(-1)?.some(({ domain }) => domain === 'workspaceSession')).toBe(
      true
    )
  })

  it('reserves ordering before an exact mutation changes live state', async () => {
    const { store, authority, readState } = await fixture()
    const gate = authority.pause()
    store.updateSettings({ theme: 'dark' })
    const first = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    await gate.started.promise
    const mutate = vi.fn(() => {
      store.updateSettings({ theme: 'light' })
      return { value: 'durable' }
    })
    const exact = store.runDurableMutation(mutate)
    await Promise.resolve()
    expect(mutate).not.toHaveBeenCalled()
    expect(store.getSettings().theme).toBe('dark')
    gate.finish.resolve()
    await first
    await expect(exact).resolves.toBe('durable')
    expect(readState().settings.theme).toBe('light')
  })

  it('retains dirty intent while many durability waiters share an active snapshot', async () => {
    const { store, authority, readState } = await fixture()
    const gate = authority.pause()
    store.updateSettings({ terminalFontSize: 12 })
    const first = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    await gate.started.promise
    const waiters: Promise<void>[] = [first]
    for (let size = 13; size <= 32; size++) {
      store.updateSettings({ terminalFontSize: size })
      waiters.push(store.flushPendingOrThrowAsync({ drainToStableGeneration: false }))
    }
    await Promise.resolve()
    expect(authority.captures).toHaveLength(1)
    gate.finish.resolve()
    await Promise.all(waiters)
    expect(readState().settings.terminalFontSize).toBe(32)
  })

  it('cancels a queued checkpoint without aborting the preceding writer or losing edits', async () => {
    const { store, authority, readState } = await fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const abortWriter = vi.spyOn(authority, 'abort')
    const gate = authority.pause()
    store.updateSettings({ theme: 'dark' })
    const first = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    await gate.started.promise
    const controller = new AbortController()
    store.updateSettings({ theme: 'light' })
    const canceled = store.flushPendingOrThrowAsync({ signal: controller.signal })
    const refused = expect(canceled).rejects.toThrow('aborted')
    controller.abort()
    gate.finish.resolve()
    await first
    await refused
    expect(abortWriter).not.toHaveBeenCalled()
    await store.flushPendingOrThrowAsync()
    expect(readState().settings.theme).toBe('light')
  })

  it.each(['known-failure', 'indeterminate'] as const)(
    'only rolls back a mutation with a known failure (%s)',
    async (outcome) => {
      const { store, authority } = await fixture()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const gate = authority.pause()
      const rollback = vi.fn()
      const exact = store.runDurableMutation(() => {
        store.updateSettings({ theme: 'dark' })
        return { value: undefined, rollback }
      })
      const rejected = expect(exact).rejects.toThrow('write failed')
      await gate.started.promise
      gate.finish.reject(new ProfileStateWriterError('test', 'write failed', outcome))
      await rejected
      expect(rollback).toHaveBeenCalledTimes(outcome === 'known-failure' ? 1 : 0)
    }
  )

  it('awaits accepted operations before closing and refuses new exact mutations', async () => {
    const { store, authority, readState } = await fixture()
    const gate = authority.pause()
    const first = store.runDurableMutation(() => {
      store.updateSettings({ theme: 'dark' })
      return { value: undefined }
    })
    await gate.started.promise
    const closing = store.freezeWritesAsync()
    await expect(store.runDurableMutation(() => ({ value: undefined }))).rejects.toThrow(
      'finalized'
    )
    expect(authority.close).not.toHaveBeenCalled()
    gate.finish.resolve()
    await first
    await closing
    expect(authority.close).toHaveBeenCalledTimes(1)
    expect(readState().settings.theme).toBe('dark')
  })
})
