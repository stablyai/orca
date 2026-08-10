import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../shared/types'
import {
  collectWorktreeTrashSweepRoots,
  getWorktreeTrashRoot,
  isWorktreeTrashEntryName,
  moveWorktreeDirectoryToTrash,
  restoreWorktreeDirectoryFromTrash,
  scheduleWorktreeTrashDeletion,
  sweepStaleWorktreeTrash,
  whenWorktreeTrashDeletionsSettled,
  WORKTREE_TRASH_DIR_NAME
} from './worktree-trash'

let scratchDir = ''

beforeEach(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), 'orca-worktree-trash-'))
})

afterEach(async () => {
  await whenWorktreeTrashDeletionsSettled()
  await rm(scratchDir, { recursive: true, force: true })
})

async function createWorktreeDirectory(worktreePath: string): Promise<void> {
  await mkdir(join(worktreePath, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(worktreePath, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
}

describe('moveWorktreeDirectoryToTrash', () => {
  it('renames the checkout into a hidden sibling trash root', async () => {
    const worktreePath = join(scratchDir, 'repo', 'feature')
    await createWorktreeDirectory(worktreePath)

    const trashPath = await moveWorktreeDirectoryToTrash(worktreePath)

    expect(trashPath).toBeDefined()
    expect(existsSync(worktreePath)).toBe(false)
    expect(trashPath!.startsWith(join(scratchDir, 'repo', WORKTREE_TRASH_DIR_NAME))).toBe(true)
    expect(existsSync(join(trashPath!, 'node_modules', 'pkg', 'index.js'))).toBe(true)
  })

  it('generates sweepable, collision-free entry names', async () => {
    const first = await moveWorktreeDirectoryToTrash(await seededWorktree('one'))
    const second = await moveWorktreeDirectoryToTrash(await seededWorktree('two'))

    expect(first).not.toEqual(second)
    expect(await readdir(join(scratchDir, 'repo', WORKTREE_TRASH_DIR_NAME))).toHaveLength(2)
    for (const entry of await readdir(join(scratchDir, 'repo', WORKTREE_TRASH_DIR_NAME))) {
      expect(isWorktreeTrashEntryName(entry)).toBe(true)
    }
  })

  it('reports the rename as unavailable and leaves no trash root when the checkout is missing', async () => {
    const worktreePath = join(scratchDir, 'repo', 'gone')

    expect(await moveWorktreeDirectoryToTrash(worktreePath)).toBeUndefined()
    expect(existsSync(getWorktreeTrashRoot(worktreePath))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('refuses a symlinked trash root', async () => {
    const worktreePath = join(scratchDir, 'repo', 'feature')
    const externalRoot = join(scratchDir, 'external')
    await createWorktreeDirectory(worktreePath)
    await mkdir(externalRoot)
    await symlink(externalRoot, getWorktreeTrashRoot(worktreePath))

    expect(await moveWorktreeDirectoryToTrash(worktreePath)).toBeUndefined()
    expect(existsSync(worktreePath)).toBe(true)
    expect(await readdir(externalRoot)).toEqual([])
  })

  async function seededWorktree(name: string): Promise<string> {
    const worktreePath = join(scratchDir, 'repo', name)
    await createWorktreeDirectory(worktreePath)
    return worktreePath
  }
})

describe('restoreWorktreeDirectoryFromTrash', () => {
  it('puts the checkout back where Git registered it', async () => {
    const worktreePath = join(scratchDir, 'repo', 'feature')
    await createWorktreeDirectory(worktreePath)
    const trashPath = await moveWorktreeDirectoryToTrash(worktreePath)

    expect(await restoreWorktreeDirectoryFromTrash(trashPath!, worktreePath)).toBe(true)
    expect(existsSync(join(worktreePath, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    expect(existsSync(trashPath!)).toBe(false)
  })

  it('reports failure instead of throwing when the trashed path is gone', async () => {
    const trashRoot = getWorktreeTrashRoot(join(scratchDir, 'repo', 'feature'))
    expect(
      await restoreWorktreeDirectoryFromTrash(
        join(trashRoot, 'wt-1-abcdef01'),
        join(scratchDir, 'repo', 'feature')
      )
    ).toBe(false)
  })
})

describe('scheduleWorktreeTrashDeletion', () => {
  it('deletes trashed checkouts in the background', async () => {
    const worktreePath = join(scratchDir, 'repo', 'feature')
    await createWorktreeDirectory(worktreePath)
    const trashPath = await moveWorktreeDirectoryToTrash(worktreePath)

    scheduleWorktreeTrashDeletion(trashPath!)
    await whenWorktreeTrashDeletionsSettled()

    expect(existsSync(trashPath!)).toBe(false)
    expect(existsSync(getWorktreeTrashRoot(worktreePath))).toBe(true)
  })
})

describe('sweepStaleWorktreeTrash', () => {
  it('removes leftover entries from both workspace layouts and nothing else', async () => {
    const nestedTrashRoot = join(scratchDir, 'repo', WORKTREE_TRASH_DIR_NAME)
    const flatTrashRoot = join(scratchDir, WORKTREE_TRASH_DIR_NAME)
    await mkdir(join(nestedTrashRoot, 'wt-1700000000000-abcdef01', 'src'), { recursive: true })
    await mkdir(join(flatTrashRoot, 'wt-1700000000001-abcdef02'), { recursive: true })
    // Not generated by Orca: a stray directory and file inside the trash root must survive.
    await mkdir(join(nestedTrashRoot, 'unrelated-directory'), { recursive: true })
    await writeFile(join(nestedTrashRoot, 'wt-notes.txt'), 'keep me\n')
    const liveWorktree = join(scratchDir, 'repo', 'feature')
    await createWorktreeDirectory(liveWorktree)

    const { removed } = await sweepStaleWorktreeTrash([scratchDir])

    expect(removed).toBe(2)
    expect(existsSync(join(nestedTrashRoot, 'wt-1700000000000-abcdef01'))).toBe(false)
    expect(existsSync(join(flatTrashRoot, 'wt-1700000000001-abcdef02'))).toBe(false)
    expect(existsSync(join(nestedTrashRoot, 'unrelated-directory'))).toBe(true)
    expect(existsSync(join(nestedTrashRoot, 'wt-notes.txt'))).toBe(true)
    expect(existsSync(join(liveWorktree, 'node_modules', 'pkg', 'index.js'))).toBe(true)
  })

  it('ignores workspace roots that do not exist', async () => {
    expect(await sweepStaleWorktreeTrash([join(scratchDir, 'missing')])).toEqual({ removed: 0 })
  })

  it('never descends past the trash roots beside worktrees', async () => {
    const deepTrashRoot = join(scratchDir, 'repo', 'feature', WORKTREE_TRASH_DIR_NAME)
    await mkdir(join(deepTrashRoot, 'wt-1700000000002-abcdef03'), { recursive: true })

    expect(await sweepStaleWorktreeTrash([scratchDir])).toEqual({ removed: 0 })
    expect(existsSync(join(deepTrashRoot, 'wt-1700000000002-abcdef03'))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'does not sweep through a symlinked trash root',
    async () => {
      const externalEntry = join(scratchDir, 'external', 'wt-1700000000003-abcdef04')
      await mkdir(externalEntry, { recursive: true })
      await symlink(join(scratchDir, 'external'), join(scratchDir, WORKTREE_TRASH_DIR_NAME))

      expect(await sweepStaleWorktreeTrash([scratchDir])).toEqual({ removed: 0 })
      expect(existsSync(externalEntry)).toBe(true)
    }
  )
})

describe('collectWorktreeTrashSweepRoots', () => {
  const settings = { workspaceDir: '/home/dev/orca/workspaces', nestWorkspaces: true }

  function repo(overrides: Partial<Repo>): Repo {
    return { id: 'repo-1', path: '/home/dev/code/orca', ...overrides } as unknown as Repo
  }

  it('collects one root per local git repo', () => {
    expect(
      collectWorktreeTrashSweepRoots(
        [repo({}), repo({ id: 'repo-2', path: '/code/other' })],
        settings
      )
    ).toEqual(['/home/dev/orca/workspaces'])
  })

  it('honours a repo-specific worktree base path', () => {
    expect(
      collectWorktreeTrashSweepRoots([repo({ worktreeBasePath: '/volumes/fast/trees' })], settings)
    ).toEqual(['/volumes/fast/trees'])
  })

  it('skips SSH repos and folder workspaces', () => {
    expect(
      collectWorktreeTrashSweepRoots(
        [repo({ connectionId: 'ssh-1' }), repo({ id: 'repo-3', kind: 'folder' })],
        settings
      )
    ).toEqual([])
  })

  it('skips WSL repos that cannot create host trash', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      expect(
        collectWorktreeTrashSweepRoots(
          [
            repo({ path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\orca' }),
            repo({
              id: 'repo-2',
              path: 'C:\\code\\orca',
              worktreeBasePath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\trees'
            })
          ],
          settings
        )
      ).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
})
