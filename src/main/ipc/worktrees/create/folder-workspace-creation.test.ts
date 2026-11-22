import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import {
  closeTestStores,
  createStore,
  testState
} from '../../../persistence/persistence-test-harness'
import { createFolderWorkspace } from './folder-workspace-creation'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../../runtime/workspaces/creation/runtime-folder-worktree-setup', () => ({
  prepareFolderWorktreeSetup: vi.fn(async () => undefined),
  isPreparedFolderSetup: () => false
}))

function createFolderRepoStore() {
  const store = createStore()
  const repo: Repo = {
    id: 'repo-folder',
    path: join(testState.dir, 'folder-project'),
    displayName: 'Folder Project',
    badgeColor: '#000000',
    addedAt: 0,
    kind: 'folder'
  }
  store.addRepo(repo)
  return { store, repo }
}

describe('createFolderWorkspace', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-folder-create-'))
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('persists and returns the supplied note', async () => {
    const { store, repo } = createFolderRepoStore()
    const comment = 'Task alpha\nKeep this workspace note.'

    const result = await createFolderWorkspace(
      { repoId: repo.id, name: 'ws', comment },
      repo,
      store
    )

    expect(result.worktree.comment).toBe(comment)
    expect(store.getWorktreeMeta(result.worktree.id)?.comment).toBe(comment)
  })

  it('keeps an empty comment when no note is supplied', async () => {
    const { store, repo } = createFolderRepoStore()

    const result = await createFolderWorkspace({ repoId: repo.id, name: 'ws' }, repo, store)

    expect(result.worktree.comment).toBe('')
    expect(store.getWorktreeMeta(result.worktree.id)?.comment).toBe('')
  })
})
