import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { completeMerge } from './commit-changes'
import { detectConflictOperation } from './git-conflict-operation'
import { resolveConflict } from './staging'

describe('delete/modify merge resolved through resolveConflict and completeMerge', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  function createDeleteModifyConflict(): {
    repoPath: string
    git: (...args: string[]) => string
  } {
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-complete-merge-'))
    tempPaths.push(repoPath)
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' })
    git('init', '--quiet', '-b', 'main')
    git('config', 'user.name', 'Orca Test')
    git('config', 'user.email', 'orca@example.test')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'core.hooksPath', '.git/no-hooks')
    writeFileSync(join(repoPath, 'gone.txt'), 'base\n')
    git('add', 'gone.txt')
    git('commit', '--quiet', '-m', 'base')
    git('checkout', '--quiet', '-b', 'feature')
    writeFileSync(join(repoPath, 'gone.txt'), 'changed on feature\n')
    git('commit', '--quiet', '-am', 'modify')
    git('checkout', '--quiet', 'main')
    git('rm', '--quiet', 'gone.txt')
    git('commit', '--quiet', '-m', 'delete')
    expect(() => git('merge', 'feature')).toThrow()
    expect(git('status', '--porcelain')).toBe('DU gone.txt\n')
    return { repoPath, git }
  }

  function createBothModifiedConflict(): ReturnType<typeof createDeleteModifyConflict> {
    const repo = createDeleteModifyConflict()
    const { repoPath, git } = repo
    git('merge', '--abort')
    writeFileSync(join(repoPath, 'both.txt'), 'base\n')
    git('add', 'both.txt')
    git('commit', '--quiet', '-m', 'add both')
    git('checkout', '--quiet', '-b', 'other')
    writeFileSync(join(repoPath, 'both.txt'), 'other\n')
    git('commit', '--quiet', '-am', 'other edit')
    git('checkout', '--quiet', 'main')
    writeFileSync(join(repoPath, 'both.txt'), 'main\n')
    git('commit', '--quiet', '-am', 'main edit')
    expect(() => git('merge', 'other')).toThrow()
    return repo
  }

  it('keeps the incoming file and concludes the merge with Git’s message', async () => {
    const { repoPath, git } = createDeleteModifyConflict()

    await resolveConflict(repoPath, 'gone.txt', 'keep_file')
    await expect(completeMerge(repoPath)).resolves.toEqual({ success: true })

    expect(git('log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2)
    expect(git('log', '-1', '--format=%B').trim()).toBe("Merge branch 'feature'")
    expect(git('show', 'HEAD:gone.txt')).toBe('changed on feature\n')
    await expect(detectConflictOperation(repoPath)).resolves.toBe('unknown')
  })

  it('keeps the deletion and removes the incoming copy Git left in the worktree', async () => {
    const { repoPath, git } = createDeleteModifyConflict()

    await resolveConflict(repoPath, 'gone.txt', 'keep_deletion')
    await expect(completeMerge(repoPath)).resolves.toEqual({ success: true })

    expect(git('ls-tree', '--name-only', 'HEAD')).toBe('')
    expect(existsSync(join(repoPath, 'gone.txt'))).toBe(false)
    expect(git('log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2)
    await expect(detectConflictOperation(repoPath)).resolves.toBe('unknown')
  })

  it('refuses to resolve a path someone already resolved, keeping their staged work', async () => {
    const { repoPath, git } = createDeleteModifyConflict()
    writeFileSync(join(repoPath, 'gone.txt'), 'hand merged\n')
    git('add', 'gone.txt')

    await expect(resolveConflict(repoPath, 'gone.txt', 'keep_deletion')).rejects.toThrow(
      'no longer in conflict'
    )
    expect(git('show', ':gone.txt')).toBe('hand merged\n')
    expect(existsSync(join(repoPath, 'gone.txt'))).toBe(true)
  })

  it('refuses a directory path even when a conflict sits inside it', async () => {
    const { repoPath } = createDeleteModifyConflict()

    await expect(resolveConflict(repoPath, '.', 'mark_resolved')).rejects.toThrow(
      'no longer in conflict'
    )
  })

  it('refuses to keep a file that is gone from disk instead of staging its deletion', async () => {
    const { repoPath, git } = createDeleteModifyConflict()
    rmSync(join(repoPath, 'gone.txt'))

    await expect(resolveConflict(repoPath, 'gone.txt', 'keep_file')).rejects.toThrow(
      'has changed since this list loaded'
    )
    expect(git('status', '--porcelain')).toBe('DU gone.txt\n')
  })

  it('refuses to delete a both-modified file, keeping the edits in progress', async () => {
    const { repoPath, git } = createBothModifiedConflict()
    writeFileSync(join(repoPath, 'both.txt'), 'half merged\n')

    await expect(resolveConflict(repoPath, 'both.txt', 'keep_deletion')).rejects.toThrow(
      'has changed since this list loaded'
    )
    expect(git('status', '--porcelain', '--', 'both.txt')).toBe('UU both.txt\n')
  })

  it('refuses to mark a both-modified file resolved once it is gone from disk', async () => {
    const { repoPath, git } = createBothModifiedConflict()
    rmSync(join(repoPath, 'both.txt'))

    await expect(resolveConflict(repoPath, 'both.txt', 'mark_resolved')).rejects.toThrow(
      'has changed since this list loaded'
    )
    expect(git('status', '--porcelain', '--', 'both.txt')).toBe('UU both.txt\n')
  })

  it('refuses without a merge in progress instead of committing staged changes', async () => {
    const { repoPath, git } = createDeleteModifyConflict()
    git('merge', '--abort')
    // A commit template gives --no-edit a message, so only the merge check stops a stray commit.
    writeFileSync(join(repoPath, '.git', 'template.txt'), 'template subject\n')
    git('config', 'commit.template', join(repoPath, '.git', 'template.txt'))
    writeFileSync(join(repoPath, 'staged.txt'), 'staged\n')
    git('add', 'staged.txt')
    const head = git('rev-parse', 'HEAD')

    await expect(completeMerge(repoPath)).resolves.toEqual({
      success: false,
      error: 'There is no merge in progress.'
    })
    expect(git('rev-parse', 'HEAD')).toBe(head)
  })
})
