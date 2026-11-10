import { expect, it, vi } from 'vitest'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../persistence-session-fixtures'
import { collectLayoutLeafIdsInOrder } from '../restoring-sessions/terminal-layout-normalization'
import { ProfileStateWriterError } from '../profile-state/profile-state-writer-errors'
import { fixture } from './profile-state-delayed-authority-fixture'

export function registerPtyBindingCreatedSurfaceRollbackTests(): void {
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
}
