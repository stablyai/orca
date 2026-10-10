import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  closeTestStores,
  createStore,
  makeRepo,
  testState,
  writeDataFile
} from './persistence-test-harness'
import { getWorkspaceAttachments } from '../shared/workspace-attachments'
import type { WorkspaceAttachment } from '../shared/worktree/types'
import { mergeWorktree } from './ipc/worktree-metadata-merge'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => false
  }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
const pr = (number: number): WorkspaceAttachment => ({ provider: 'github', type: 'pr', number })

describe('workspace attachment persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-attachments-'))
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('round-trips collections and active selection through host-qualified metadata and git projections', async () => {
    writeDataFile({ repos: [makeRepo({ id: 'repo', path: '/work', connectionId: 'test' })] })
    const store = await createStore()
    store.setWorktreeMetaForHost('repo::/work', 'ssh:test', { linkedPR: 7 })
    store.setWorktreeMetaForHost('repo::/work', 'ssh:test', { linkedPR: 8 })
    store.flush()
    const restored = await createStore()
    const meta = restored.getWorktreeMetaForHost('repo::/work', 'ssh:test')
    expect(meta?.linkedItems).toEqual([pr(7), pr(8)])
    expect(meta?.linkedPR).toBe(8)
    const projected = mergeWorktree(
      'repo',
      { path: '/work', head: 'abc', branch: 'feature', isBare: false, isMainWorktree: false },
      meta
    )
    expect(projected.linkedItems).toEqual([pr(7), pr(8)])
    expect(
      restored.setWorktreeMetaForHost('repo::/work', 'ssh:test', { linkedItems: [pr(7)] }).linkedPR
    ).toBe(7)
    restored.flush()
    expect(
      (await createStore()).getWorktreeMetaForHost('repo::/work', 'ssh:test')?.linkedItems
    ).toEqual([pr(7)])
  })

  it('loads scalar-only metadata and repairs malformed duplicate collection entries', async () => {
    writeDataFile({
      worktreeMeta: {
        legacy: { linkedPR: 7 },
        repaired: { linkedPR: 7, linkedItems: [pr(7), null, {}, pr(7), pr(8)] }
      }
    })
    const store = await createStore()
    expect(getWorkspaceAttachments(store.getWorktreeMeta('legacy'))).toEqual([pr(7)])
    expect(store.getWorktreeMeta('repaired')?.linkedItems).toEqual([pr(7), pr(8)])
    store.setWorktreeMeta('legacy', { linkedPR: 8 })
    expect(store.getWorktreeMeta('legacy')?.linkedItems).toEqual([pr(7), pr(8)])
  })

  it('retains multiple repo-less folder tasks and clears the active task when its collection is emptied', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Docs',
      parentPath: '/docs',
      createdFrom: 'folder-scan'
    })
    const task = (number: number) => ({
      provider: 'github' as const,
      type: 'issue' as const,
      number,
      title: `Issue ${number}`,
      url: `https://github.com/a/docs/issues/${number}`
    })
    const workspace = store.createFolderWorkspace({ projectGroupId: group.id, linkedTask: task(7) })
    store.updateFolderWorkspace(workspace.id, { linkedTask: task(8) })
    expect(workspace.linkedItems).toHaveLength(2)
    store.flush()
    const restored = await createStore()
    expect(restored.getFolderWorkspace(workspace.id)?.linkedItems).toHaveLength(2)
    expect(restored.updateFolderWorkspace(workspace.id, { linkedItems: [] })?.linkedTask).toBeNull()
    restored.flush()
    expect((await createStore()).getFolderWorkspace(workspace.id)?.linkedItems).toEqual([])
  })
  it('applies stale client add/remove deltas atomically for worktrees and folders', async () => {
    const store = await createStore()
    store.setWorktreeMeta('wt', { linkedItems: [pr(1)] })
    const firstClient = { linkedItemsBase: [pr(1)], linkedItems: [pr(1), pr(2)] }
    const secondClient = { linkedItemsBase: [pr(1)], linkedItems: [pr(3)] }
    store.setWorktreeMeta('wt', firstClient)
    store.setWorktreeMeta('wt', secondClient)
    expect(store.getWorktreeMeta('wt')?.linkedItems).toEqual([pr(2), pr(3)])
    expect(store.getWorktreeMeta('wt')).not.toHaveProperty('linkedItemsBase')
    const group = store.createProjectGroup({
      name: 'Folder',
      parentPath: '/docs',
      createdFrom: 'folder-scan'
    })
    const folder = store.createFolderWorkspace({ projectGroupId: group.id, linkedItems: [pr(1)] })
    store.updateFolderWorkspace(folder.id, firstClient)
    store.updateFolderWorkspace(folder.id, secondClient)
    expect(folder.linkedItems).toEqual([pr(2), pr(3)])
    expect(folder).not.toHaveProperty('linkedItemsBase')
    store.flush()
    const restored = await createStore()
    expect(restored.getWorktreeMeta('wt')?.linkedItems).toEqual([pr(2), pr(3)])
    expect(restored.getFolderWorkspace(folder.id)?.linkedItems).toEqual([pr(2), pr(3)])
  })

  it('keeps the current review target when a stale collection edit resolved another review', async () => {
    const store = await createStore()
    const currentTarget = { remoteName: 'origin', branchName: 'pr-2' }
    store.setWorktreeMeta('wt', { linkedItems: [pr(2)], linkedPR: 2, pushTarget: currentTarget })
    store.setWorktreeMeta('wt', {
      linkedItemsBase: [],
      linkedItems: [pr(1)],
      linkedPR: 1,
      linkedItemsSelectionChanged: false,
      pushTarget: { remoteName: 'origin', branchName: 'pr-1' }
    })
    expect(store.getWorktreeMeta('wt')).toMatchObject({
      linkedPR: 2,
      linkedItems: [pr(2), pr(1)],
      pushTarget: currentTarget
    })
    store.setWorktreeMeta('wt', {
      linkedItemsBase: [pr(2), pr(1)],
      linkedItems: [pr(2), pr(1)],
      linkedPR: 1,
      linkedItemsSelectionChanged: true,
      pushTarget: { remoteName: 'origin', branchName: 'pr-1' }
    })
    expect(store.getWorktreeMeta('wt')).toMatchObject({
      linkedPR: 1,
      pushTarget: { remoteName: 'origin', branchName: 'pr-1' }
    })
  })
})
