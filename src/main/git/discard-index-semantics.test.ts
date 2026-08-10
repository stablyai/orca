import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bulkDiscardChanges,
  bulkDiscardStagedChanges,
  bulkDiscardStagedChangesWithReceipt,
  bulkUnstageFiles,
  discardChanges
} from './status'

type Snapshot = {
  cachedDiff: string
  index: string
  status: string
  worktree: string | null
}

const repos: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'orca-discard-oracle-'))
  repos.push(repo)
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'discard-oracle@example.invalid')
  git(repo, 'config', 'user.name', 'Discard Oracle')
  git(repo, 'config', 'commit.gpgsign', 'false')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(path.join(repo, 'file.txt'), 'base-1\nbase-2\nbase-3\n')
  git(repo, 'add', 'file.txt')
  git(repo, 'commit', '-qm', 'base')
  return repo
}

function snapshot(repo: string, relativePath: string): Snapshot {
  const file = path.join(repo, relativePath)
  return {
    cachedDiff: git(repo, 'diff', '--cached', '--', relativePath),
    index: git(repo, 'ls-files', '--stage', '--', relativePath),
    status: git(repo, 'status', '--porcelain=v1'),
    worktree: existsSync(file) ? readFileSync(file, 'utf8') : null
  }
}

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true })
  }
})

describe('discard index/worktree semantics', () => {
  it('keeps a tracked staged-only blob in both the index and worktree', async () => {
    const repo = initRepo()
    writeFileSync(path.join(repo, 'file.txt'), 'staged\n')
    git(repo, 'add', 'file.txt')
    const before = snapshot(repo, 'file.txt')

    await discardChanges(repo, 'file.txt')

    expect(snapshot(repo, 'file.txt')).toEqual(before)
  })

  it('removes only unstaged edits layered over a staged blob', async () => {
    const repo = initRepo()
    writeFileSync(path.join(repo, 'file.txt'), 'staged\n')
    git(repo, 'add', 'file.txt')
    appendFileSync(path.join(repo, 'file.txt'), 'unstaged\n')
    const indexBefore = snapshot(repo, 'file.txt')

    await discardChanges(repo, 'file.txt')

    const after = snapshot(repo, 'file.txt')
    expect(after.index).toBe(indexBefore.index)
    expect(after.cachedDiff).toBe(indexBefore.cachedDiff)
    expect(after.worktree).toBe('staged\n')
    expect(after.status).toBe('M  file.txt\n')
  })

  it('keeps a staged new file while removing its unstaged suffix', async () => {
    const repo = initRepo()
    writeFileSync(path.join(repo, 'new.txt'), 'staged-new\n')
    git(repo, 'add', 'new.txt')
    appendFileSync(path.join(repo, 'new.txt'), 'unstaged\n')
    const indexBefore = snapshot(repo, 'new.txt')

    await discardChanges(repo, 'new.txt')

    const after = snapshot(repo, 'new.txt')
    expect(after.index).toBe(indexBefore.index)
    expect(after.cachedDiff).toBe(indexBefore.cachedDiff)
    expect(after.worktree).toBe('staged-new\n')
    expect(after.status).toBe('A  new.txt\n')
  })

  it('deletes an intent-to-add path as promised by the Source Control dialog', async () => {
    const repo = initRepo()
    writeFileSync(path.join(repo, 'intent.txt'), 'intent content\n')
    git(repo, 'add', '-N', 'intent.txt')

    await discardChanges(repo, 'intent.txt')

    expect(snapshot(repo, 'intent.txt')).toEqual({
      cachedDiff: '',
      index: '',
      status: '',
      worktree: null
    })
  })

  it('preserves a staged rename while discarding an edit to the new path', async () => {
    const repo = initRepo()
    git(repo, 'mv', 'file.txt', 'renamed.txt')
    appendFileSync(path.join(repo, 'renamed.txt'), 'unstaged\n')
    const indexBefore = snapshot(repo, 'renamed.txt')

    await discardChanges(repo, 'renamed.txt')

    const after = snapshot(repo, 'renamed.txt')
    expect(after.index).toBe(indexBefore.index)
    expect(after.cachedDiff).toBe(indexBefore.cachedDiff)
    expect(after.worktree).toBe('base-1\nbase-2\nbase-3\n')
    expect(after.status).toBe('R  file.txt -> renamed.txt\n')
  })

  it('restores a worktree deletion from the staged blob', async () => {
    const repo = initRepo()
    writeFileSync(path.join(repo, 'file.txt'), 'staged\n')
    git(repo, 'add', 'file.txt')
    rmSync(path.join(repo, 'file.txt'))
    const indexBefore = snapshot(repo, 'file.txt')

    await discardChanges(repo, 'file.txt')

    const after = snapshot(repo, 'file.txt')
    expect(after.index).toBe(indexBefore.index)
    expect(after.cachedDiff).toBe(indexBefore.cachedDiff)
    expect(after.worktree).toBe('staged\n')
    expect(after.status).toBe('M  file.txt\n')
  })

  it('deletes a genuinely untracked file and leaves no index entry', async () => {
    const repo = initRepo()
    writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n')

    await discardChanges(repo, 'untracked.txt')

    expect(snapshot(repo, 'untracked.txt')).toEqual({
      cachedDiff: '',
      index: '',
      status: '',
      worktree: null
    })
  })

  it('refuses an unmerged path without changing its index or worktree', async () => {
    const repo = initRepo()
    const baseBranch = git(repo, 'branch', '--show-current').trim()
    git(repo, 'checkout', '-qb', 'side')
    writeFileSync(path.join(repo, 'file.txt'), 'side\n')
    git(repo, 'commit', '-qam', 'side')
    git(repo, 'checkout', '-q', baseBranch)
    writeFileSync(path.join(repo, 'file.txt'), 'main\n')
    git(repo, 'commit', '-qam', 'main')
    expect(() => git(repo, 'merge', 'side')).toThrow()
    const before = snapshot(repo, 'file.txt')

    await expect(discardChanges(repo, 'file.txt')).rejects.toThrow()

    expect(snapshot(repo, 'file.txt')).toEqual(before)
  })

  it('preserves the staged hunk in a partial-index file', async () => {
    const repo = initRepo()
    writeFileSync(path.join(repo, 'file.txt'), 'staged-1\nbase-2\nbase-3\n')
    git(repo, 'add', 'file.txt')
    writeFileSync(path.join(repo, 'file.txt'), 'staged-1\nbase-2\nunstaged-3\n')
    const indexBefore = snapshot(repo, 'file.txt')

    await discardChanges(repo, 'file.txt')

    const after = snapshot(repo, 'file.txt')
    expect(after.index).toBe(indexBefore.index)
    expect(after.cachedDiff).toBe(indexBefore.cachedDiff)
    expect(after.worktree).toBe('staged-1\nbase-2\nbase-3\n')
    expect(after.status).toBe('M  file.txt\n')
  })

  it('uses the same preservation rule for a bulk mixed-state discard', async () => {
    const repo = initRepo()
    writeFileSync(path.join(repo, 'file.txt'), 'staged\n')
    git(repo, 'add', 'file.txt')
    appendFileSync(path.join(repo, 'file.txt'), 'unstaged\n')
    writeFileSync(path.join(repo, 'new.txt'), 'staged-new\n')
    git(repo, 'add', 'new.txt')
    appendFileSync(path.join(repo, 'new.txt'), 'unstaged\n')
    writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n')

    await bulkDiscardChanges(repo, ['file.txt', 'new.txt', 'untracked.txt'])

    expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('staged\n')
    expect(readFileSync(path.join(repo, 'new.txt'), 'utf8')).toBe('staged-new\n')
    expect(existsSync(path.join(repo, 'untracked.txt'))).toBe(false)
    expect(git(repo, 'status', '--porcelain=v1')).toBe('M  file.txt\nA  new.txt\n')
  })

  it('atomically discards staged, unstaged, added, and renamed content', async () => {
    const repo = initRepo()
    writeFileSync(path.join(repo, 'file.txt'), 'staged\n')
    git(repo, 'add', 'file.txt')
    appendFileSync(path.join(repo, 'file.txt'), 'unstaged\n')
    writeFileSync(path.join(repo, 'new.txt'), 'new\n')
    git(repo, 'add', 'new.txt')

    await bulkDiscardStagedChanges(repo, ['file.txt', 'new.txt'])

    expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('base-1\nbase-2\nbase-3\n')
    expect(existsSync(path.join(repo, 'new.txt'))).toBe(false)
    expect(git(repo, 'status', '--porcelain=v1')).toBe('')

    git(repo, 'mv', 'file.txt', 'renamed.txt')
    await bulkDiscardStagedChanges(repo, ['file.txt', 'renamed.txt'])
    expect(existsSync(path.join(repo, 'renamed.txt'))).toBe(false)
    expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('base-1\nbase-2\nbase-3\n')
    expect(git(repo, 'status', '--porcelain=v1')).toBe('')
  })

  it('restores rename sources expanded beyond one bounded batch', async () => {
    const repo = initRepo()
    const renamedPaths: string[] = []
    for (let index = 0; index < 101; index += 1) {
      const original = `original-${index}.txt`
      const renamed = `renamed-${index}.txt`
      writeFileSync(path.join(repo, original), `${index}\n`)
      renamedPaths.push(renamed)
    }
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'rename fixtures')
    for (let index = 0; index < 101; index += 1) {
      git(repo, 'mv', `original-${index}.txt`, renamedPaths[index])
    }

    await bulkDiscardStagedChanges(repo, renamedPaths)

    expect(git(repo, 'status', '--porcelain=v1')).toBe('')
    expect(existsSync(path.join(repo, 'original-100.txt'))).toBe(true)
    expect(existsSync(path.join(repo, 'renamed-100.txt'))).toBe(false)
  })

  it('reports completed and uncertain batches after a real permission failure', async () => {
    const repo = initRepo()
    const paths: string[] = []
    for (let index = 0; index < 100; index += 1) {
      const relativePath = `writable-${index}.txt`
      paths.push(relativePath)
      writeFileSync(path.join(repo, relativePath), `base-${index}\n`)
    }
    mkdirSync(path.join(repo, 'locked'))
    paths.push('locked/final.txt')
    writeFileSync(path.join(repo, 'locked/final.txt'), 'base-locked\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'permission fixtures')
    for (const relativePath of paths) {
      writeFileSync(path.join(repo, relativePath), `staged-${relativePath}\n`)
    }
    git(repo, 'add', '.')
    for (const relativePath of paths) {
      writeFileSync(path.join(repo, relativePath), `worktree-${relativePath}\n`)
    }
    chmodSync(path.join(repo, 'locked'), 0o555)

    const receipt = await bulkDiscardStagedChangesWithReceipt(repo, paths, 'permission-op')
    chmodSync(path.join(repo, 'locked'), 0o755)

    expect(receipt).toMatchObject({
      state: 'failed',
      mutation: 'partial',
      completedPaths: paths.slice(0, 100),
      uncertainPaths: ['locked/final.txt'],
      remainingPaths: []
    })
    expect(readFileSync(path.join(repo, 'writable-99.txt'), 'utf8')).toBe('base-99\n')
    expect(readFileSync(path.join(repo, 'locked/final.txt'), 'utf8')).toBe(
      'worktree-locked/final.txt\n'
    )
    expect(git(repo, 'diff', '--cached')).toBe('')
    expect(git(repo, 'status', '--short')).toBe(' M locked/final.txt\n')
  })

  it('keeps the legacy old-client/new-host two-step behavior safe', async () => {
    const repo = initRepo()
    writeFileSync(path.join(repo, 'file.txt'), 'staged\n')
    git(repo, 'add', 'file.txt')
    appendFileSync(path.join(repo, 'file.txt'), 'unstaged\n')

    await bulkUnstageFiles(repo, ['file.txt'])
    await bulkDiscardChanges(repo, ['file.txt'])

    expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('base-1\nbase-2\nbase-3\n')
    expect(git(repo, 'status', '--porcelain=v1')).toBe('')
  })

  it('deletes only selected staged files from an unborn repository', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'orca-discard-unborn-'))
    repos.push(repo)
    git(repo, 'init', '-q')
    writeFileSync(path.join(repo, 'selected.txt'), 'selected\n')
    writeFileSync(path.join(repo, 'unrelated.txt'), 'unrelated\n')
    git(repo, 'add', 'selected.txt', 'unrelated.txt')
    const unrelatedBefore = snapshot(repo, 'unrelated.txt')

    await bulkDiscardStagedChanges(repo, ['selected.txt'])

    expect(snapshot(repo, 'selected.txt')).toEqual({
      cachedDiff: '',
      index: '',
      status: 'A  unrelated.txt\n',
      worktree: null
    })
    const unrelatedAfter = snapshot(repo, 'unrelated.txt')
    expect(unrelatedAfter.cachedDiff).toBe(unrelatedBefore.cachedDiff)
    expect(unrelatedAfter.index).toBe(unrelatedBefore.index)
    expect(unrelatedAfter.worktree).toBe(unrelatedBefore.worktree)
    expect(unrelatedAfter.status).toBe('A  unrelated.txt\n')
  })

  it('rejects a conflicted staged discard without changing index or worktree state', async () => {
    const repo = initRepo()
    const baseBranch = git(repo, 'branch', '--show-current').trim()
    git(repo, 'checkout', '-qb', 'side')
    writeFileSync(path.join(repo, 'file.txt'), 'side\n')
    git(repo, 'commit', '-qam', 'side')
    git(repo, 'checkout', '-q', baseBranch)
    writeFileSync(path.join(repo, 'file.txt'), 'main\n')
    git(repo, 'commit', '-qam', 'main')
    expect(() => git(repo, 'merge', 'side')).toThrow()
    const before = snapshot(repo, 'file.txt')

    await expect(bulkDiscardStagedChanges(repo, ['file.txt'])).rejects.toThrow('conflicted')

    expect(snapshot(repo, 'file.txt')).toEqual(before)
  })

  it('works from a linked worktree without changing the main checkout', async () => {
    const repo = initRepo()
    const linked = `${repo}-linked`
    repos.push(linked)
    git(repo, 'worktree', 'add', '-qb', 'linked', linked)
    writeFileSync(path.join(linked, 'file.txt'), 'linked-staged\n')
    git(linked, 'add', 'file.txt')
    appendFileSync(path.join(linked, 'file.txt'), 'linked-unstaged\n')

    await discardChanges(linked, 'file.txt')

    expect(readFileSync(path.join(linked, 'file.txt'), 'utf8')).toBe('linked-staged\n')
    await bulkDiscardStagedChanges(linked, ['file.txt'])
    expect(readFileSync(path.join(linked, 'file.txt'), 'utf8')).toBe('base-1\nbase-2\nbase-3\n')
    expect(git(linked, 'status', '--porcelain=v1')).toBe('')
    expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('base-1\nbase-2\nbase-3\n')
  })

  it('does not delete a file when a folder workspace is not a Git repository', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'orca-discard-folder-'))
    repos.push(folder)
    writeFileSync(path.join(folder, 'file.txt'), 'folder content\n')

    await expect(discardChanges(folder, 'file.txt')).rejects.toThrow()
    await expect(bulkDiscardStagedChanges(folder, ['file.txt'])).rejects.toThrow()

    expect(readFileSync(path.join(folder, 'file.txt'), 'utf8')).toBe('folder content\n')
  })
})
