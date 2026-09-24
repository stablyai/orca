import { describe, expect, it, vi } from 'vitest'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../../persistence-session-fixtures'
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

const binding = {
  worktreeId: 'repo-local::/fixture/local',
  tabId: 'async-binding-tab',
  leafId: TEST_LEAF_1,
  ptyId: 'async-binding-pty',
  incarnationId: 'async-binding-incarnation'
}

describe('durable asynchronous PTY binding', () => {
  it('acknowledges only after the binding reaches SQLite', async () => {
    const { store, authority, readState } = await fixture()
    const gate = authority.pause()
    let acknowledged = false
    const pending = store.persistPtyBinding(binding).then((result) => {
      acknowledged = true
      return result
    })
    await gate.started.promise
    expect(acknowledged).toBe(false)
    expect(readState().workspaceSession.terminalLayoutsByTabId[binding.tabId]).toBeUndefined()
    gate.finish.resolve()
    expect(await pending).toBe(true)
    expect(
      readState().workspaceSession.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId
    ).toEqual({
      [binding.leafId]: binding.ptyId
    })
  })

  it('evaluates membership refusal after an older write finishes', async () => {
    const { store, authority } = await fixture()
    await store.persistPtyBinding(binding)
    const gate = authority.pause()
    store.updateSettings({ theme: 'dark' })
    const older = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    await gate.started.promise
    const resolveBinding = vi.fn(() => ({ ...binding, mayCreate: false }))
    const queued = store.persistPtyBinding(resolveBinding)
    expect(resolveBinding).not.toHaveBeenCalled()
    const session = store.getWorkspaceSession()
    session.tabsByWorktree[binding.worktreeId] = []
    delete session.terminalLayoutsByTabId[binding.tabId]
    store.setWorkspaceSession(session)
    gate.finish.resolve()
    await older
    expect(await queued).toBe(false)
    expect(resolveBinding).toHaveBeenCalledTimes(1)
  })

  it('restores the binding after a known write failure', async () => {
    const { store, authority } = await fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = structuredClone(store.getWorkspaceSession())
    const gate = authority.pause()
    const rejected = expect(store.persistPtyBinding(binding)).rejects.toThrow('disk refused')
    await gate.started.promise
    gate.finish.reject(
      new ProfileStateWriterError('test-disk-failure', 'disk refused', 'known-failure')
    )
    await rejected
    expect(store.getWorkspaceSession()).toEqual(before)
  })

  it('preserves newer getter edits when an older binding write fails', async () => {
    const { store, authority } = await fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const gate = authority.pause()
    const rejected = expect(store.persistPtyBinding(binding)).rejects.toThrow('disk refused')
    await gate.started.promise
    store.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId = {
      [binding.leafId]: 'newer-pty'
    }
    gate.finish.reject(
      new ProfileStateWriterError('test-disk-failure', 'disk refused', 'known-failure')
    )
    await rejected
    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId
    ).toEqual({
      [binding.leafId]: 'newer-pty'
    })
  })

  it.each(['tab title', 'pane title'] as const)(
    'rolls back a failed replacement while preserving a newer %s',
    async (edit) => {
      const { store, authority, readState } = await fixture()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await store.persistPtyBinding(binding)
      const gate = authority.pause()
      const rejected = expect(
        store.persistPtyBinding({
          ...binding,
          ptyId: 'failed-replacement',
          incarnationId: 'failed-incarnation',
          expectedBinding: binding
        })
      ).rejects.toThrow('disk refused')
      await gate.started.promise
      const session = store.getWorkspaceSession()
      const tab = session.tabsByWorktree[binding.worktreeId].find(
        (candidate) => candidate.id === binding.tabId
      )
      if (!tab) {
        throw new Error('binding did not create its terminal row')
      }
      if (edit === 'tab title') {
        tab.customTitle = 'new title'
      } else {
        session.terminalLayoutsByTabId[binding.tabId].titlesByLeafId = {
          [binding.leafId]: 'new title'
        }
      }
      gate.finish.reject(
        new ProfileStateWriterError('test-disk-failure', 'disk refused', 'known-failure')
      )
      await rejected
      await store.flushPendingOrThrowAsync()
      const persisted = readState().workspaceSession
      expect(persisted.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId).toEqual({
        [binding.leafId]: binding.ptyId
      })
      expect(persisted.terminalPtyIncarnationsByPaneKey[`${binding.tabId}:${binding.leafId}`]).toBe(
        binding.incarnationId
      )
      if (edit === 'tab title') {
        expect(persisted.tabsByWorktree[binding.worktreeId]).toContainEqual(
          expect.objectContaining({ id: binding.tabId, customTitle: 'new title' })
        )
      } else {
        expect(persisted.terminalLayoutsByTabId[binding.tabId].titlesByLeafId).toEqual({
          [binding.leafId]: 'new title'
        })
      }
    }
  )

  it('rolls back a failed binding while retaining an unrelated newer navigation edit', async () => {
    const { store, authority } = await fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const gate = authority.pause()
    const rejected = expect(store.persistPtyBinding(binding)).rejects.toThrow('disk refused')
    await gate.started.promise
    store.getWorkspaceSession().activeRepoId = 'newer-repo'
    gate.finish.reject(
      new ProfileStateWriterError('test-disk-failure', 'disk refused', 'known-failure')
    )
    await rejected
    expect(store.getWorkspaceSession().activeRepoId).toBe('newer-repo')
    expect(store.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId]).toBeUndefined()
  })

  it('retains a newer root sibling when rolling back a failed leaf replacement', async () => {
    const { store, authority, readState } = await fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await store.persistPtyBinding(binding)
    const gate = authority.pause()
    const rejected = expect(
      store.persistPtyBinding({ ...binding, ptyId: 'failed-replacement' })
    ).rejects.toThrow('disk refused')
    await gate.started.promise
    const session = store.getWorkspaceSession()
    const tab = session.tabsByWorktree[binding.worktreeId].find(
      (candidate) => candidate.id === binding.tabId
    )
    if (!tab) {
      throw new Error('binding did not create its terminal row')
    }
    const layout = session.terminalLayoutsByTabId[binding.tabId]
    layout.root = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: TEST_LEAF_2 },
      second: { type: 'leaf', leafId: binding.leafId }
    }
    layout.ptyIdsByLeafId = { ...layout.ptyIdsByLeafId, [TEST_LEAF_2]: 'new-root-pty' }
    tab.ptyId = 'new-root-pty'
    gate.finish.reject(
      new ProfileStateWriterError('test-disk-failure', 'disk refused', 'known-failure')
    )
    await rejected
    await store.flushPendingOrThrowAsync()
    const persisted = readState().workspaceSession
    expect(persisted.terminalLayoutsByTabId[binding.tabId].root).toEqual(layout.root)
    expect(persisted.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId).toEqual({
      [binding.leafId]: binding.ptyId,
      [TEST_LEAF_2]: 'new-root-pty'
    })
    expect(persisted.tabsByWorktree[binding.worktreeId]).toContainEqual(
      expect.objectContaining({ id: binding.tabId, ptyId: 'new-root-pty' })
    )
  })

  it('removes a failed new binding while retaining a newer sibling tab', async () => {
    const { store, authority } = await fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const gate = authority.pause()
    const rejected = expect(store.persistPtyBinding(binding)).rejects.toThrow('disk refused')
    await gate.started.promise
    const tabs = store.getWorkspaceSession().tabsByWorktree[binding.worktreeId]
    const boundTab = tabs.find((tab) => tab.id === binding.tabId)
    if (!boundTab) {
      throw new Error('binding did not create its terminal row')
    }
    tabs.push({ ...boundTab, id: 'newer-sibling', ptyId: 'newer-sibling-pty' })
    gate.finish.reject(
      new ProfileStateWriterError('test-disk-failure', 'disk refused', 'known-failure')
    )
    await rejected
    expect(
      store.getWorkspaceSession().tabsByWorktree[binding.worktreeId].map((tab) => tab.id)
    ).toContain('newer-sibling')
    expect(
      store.getWorkspaceSession().tabsByWorktree[binding.worktreeId].map((tab) => tab.id)
    ).not.toContain(binding.tabId)
    expect(store.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId]).toBeUndefined()
  })

  it('retains a binding whose commit outcome is indeterminate', async () => {
    const { store, authority } = await fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const gate = authority.pause()
    const rejected = expect(store.persistPtyBinding(binding)).rejects.toThrow('worker exited')
    await gate.started.promise
    gate.finish.reject(
      new ProfileStateWriterError('test-worker-exit', 'worker exited', 'indeterminate')
    )
    await rejected
    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId
    ).toEqual({
      [binding.leafId]: binding.ptyId
    })
  })
})
