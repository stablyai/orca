import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import {
  closeTestStores,
  createStore,
  makeRepo,
  testState
} from '../../persistence/persistence-test-harness'
import { relocateRepoPath } from './runtime-repository-relocation'

const noop = (): void => {}
const deps = {
  invalidateResolvedWorktrees: noop,
  invalidateWorktreeScan: noop,
  notifyReposChanged: noop,
  notifyWorktreeFolderRenamed: noop
}

function gitInit(path: string): void {
  mkdirSync(path, { recursive: true })
  execFileSync('git', ['init', '-q', path])
}

describe('relocateRepoPath', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-repo-relocate-')))
    testState.dir = join(root, 'profile')
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps the repo id and the primary workspace metadata when its folder moves', async () => {
    const oldPath = join(root, 'old')
    const newPath = join(root, 'new')
    const otherPath = join(root, 'other')
    gitInit(oldPath)
    gitInit(otherPath)
    const store = createStore()
    store.addRepo(makeRepo({ id: 'r1', path: oldPath, kind: 'git' }))
    store.addRepo(makeRepo({ id: 'r2', path: otherPath, kind: 'git', displayName: 'other' }))
    store.setWorktreeMeta(hostWorktreeTarget({ id: `r1::${oldPath}`, hostId: 'local' }), {
      displayName: 'Primary'
    })
    renameSync(oldPath, newPath)

    const moved = await relocateRepoPath(store, store.getRepo('r1')!, newPath, deps)
    store.flush()

    expect(moved.id).toBe('r1')
    expect(moved.path).toBe(newPath)
    const reloaded = createStore()
    expect(reloaded.getRepo('r1')?.path).toBe(newPath)
    expect(reloaded.getWorktreeMetaForHost(`r1::${newPath}`, 'local')?.displayName).toBe('Primary')
    expect(reloaded.getWorktreeMetaForHost(`r1::${oldPath}`, 'local')).toBeUndefined()

    await expect(relocateRepoPath(store, moved, otherPath, deps)).rejects.toThrow(
      `${otherPath} is already registered as project "other".`
    )
    expect(store.getRepo('r1')?.path).toBe(newPath)
  })
})
