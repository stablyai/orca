import { expect, it, vi } from 'vitest'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../../persistence-session-fixtures'
import { collectLayoutLeafIdsInOrder } from '../restoring-sessions/terminal-layout-normalization'
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

it.each(['tab title', 'pane title', 'new sibling'] as const)(
  'retains a valid unbound new surface after a failed binding and newer %s',
  async (edit) => {
    const { store, authority, readState } = await fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const binding = {
      worktreeId: 'repo-local::/fixture/local',
      tabId: 'new-binding-tab',
      leafId: TEST_LEAF_1,
      ptyId: 'failed-pty',
      incarnationId: 'failed-incarnation'
    }
    const gate = authority.pause()
    const rejected = expect(store.persistPtyBinding(binding)).rejects.toThrow('disk refused')
    await gate.started.promise
    const session = store.getWorkspaceSession()
    const tab = session.tabsByWorktree[binding.worktreeId].find(
      (candidate) => candidate.id === binding.tabId
    )
    if (!tab) {
      throw new Error('binding did not create its terminal row')
    }
    const layout = session.terminalLayoutsByTabId[binding.tabId]
    if (edit === 'tab title') {
      tab.customTitle = 'new title'
    } else if (edit === 'pane title') {
      layout.titlesByLeafId = { [binding.leafId]: 'new title' }
    } else {
      layout.root = {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: binding.leafId },
        second: { type: 'leaf', leafId: TEST_LEAF_2 }
      }
      layout.ptyIdsByLeafId = { ...layout.ptyIdsByLeafId, [TEST_LEAF_2]: 'sibling-pty' }
      session.terminalPtyIncarnationsByPaneKey = {
        ...session.terminalPtyIncarnationsByPaneKey,
        [`${binding.tabId}:${TEST_LEAF_2}`]: 'sibling-incarnation'
      }
      tab.ptyId = 'sibling-pty'
    }
    gate.finish.reject(
      new ProfileStateWriterError('test-disk-failure', 'disk refused', 'known-failure')
    )
    await rejected
    await store.flushPendingOrThrowAsync()
    const persisted = readState().workspaceSession
    expect(JSON.stringify(persisted)).not.toContain('failed-pty')
    expect(JSON.stringify(persisted)).not.toContain('failed-incarnation')
    expect(persisted.tabsByWorktree[binding.worktreeId]).toContainEqual(
      expect.objectContaining({
        id: binding.tabId,
        worktreeId: binding.worktreeId,
        createdAt: expect.any(Number),
        ptyId: edit === 'new sibling' ? 'sibling-pty' : null,
        ...(edit === 'tab title' ? { customTitle: 'new title' } : {})
      })
    )
    expect(persisted.terminalLayoutsByTabId[binding.tabId]).toMatchObject({
      root: layout.root,
      ...(edit === 'pane title' ? { titlesByLeafId: { [binding.leafId]: 'new title' } } : {})
    })
    if (edit === 'new sibling') {
      expect(persisted.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId).toEqual({
        [TEST_LEAF_2]: 'sibling-pty'
      })
      expect(persisted.terminalPtyIncarnationsByPaneKey).toEqual({
        [`${binding.tabId}:${TEST_LEAF_2}`]: 'sibling-incarnation'
      })
    }
  }
)

it('preserves the valid newer tree after a failed split insertion', async () => {
  const { store, authority, readState } = await fixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const binding = {
    worktreeId: 'repo-local::/fixture/local',
    tabId: 'split-binding-tab',
    leafId: TEST_LEAF_1,
    ptyId: 'original-pty',
    incarnationId: 'original-incarnation'
  }
  await store.persistPtyBinding(binding)
  const gate = authority.pause()
  const rejected = expect(
    store.persistPtyBinding({
      ...binding,
      leafId: TEST_LEAF_2,
      ptyId: 'failed-pty',
      incarnationId: 'failed-incarnation'
    })
  ).rejects.toThrow('disk refused')
  await gate.started.promise
  const layout = store.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId]
  if (!layout.root) {
    throw new Error('binding did not create its layout')
  }
  const laterLeaf = '33333333-3333-4333-8333-333333333333'
  layout.root = {
    type: 'split',
    direction: 'horizontal',
    first: layout.root,
    second: { type: 'leaf', leafId: laterLeaf }
  }
  layout.ptyIdsByLeafId = { ...layout.ptyIdsByLeafId, [laterLeaf]: 'later-sibling-pty' }
  const expectedRoot = structuredClone(layout.root)
  gate.finish.reject(
    new ProfileStateWriterError('test-disk-failure', 'disk refused', 'known-failure')
  )
  await rejected
  await store.flushPendingOrThrowAsync()
  const persisted = readState().workspaceSession.terminalLayoutsByTabId[binding.tabId]
  expect(persisted.root).toEqual(expectedRoot)
  expect(collectLayoutLeafIdsInOrder(persisted.root)).toContain(laterLeaf)
  expect(persisted.ptyIdsByLeafId).toEqual({
    [TEST_LEAF_1]: 'original-pty',
    [laterLeaf]: 'later-sibling-pty'
  })
})
