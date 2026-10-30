import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { completeMerge } from './commit-changes'
import { detectConflictOperation } from './git-conflict-operation'
import { stageFile } from './staging'

describe('delete/modify merge resolved through stage and completeMerge', () => {
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

  it('keeps the incoming file and concludes the merge with Git’s message', async () => {
    const { repoPath, git } = createDeleteModifyConflict()

    await stageFile(repoPath, 'gone.txt')
    await expect(completeMerge(repoPath)).resolves.toEqual({ success: true })

    expect(git('log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2)
    expect(git('log', '-1', '--format=%B').trim()).toBe("Merge branch 'feature'")
    expect(git('show', 'HEAD:gone.txt')).toBe('changed on feature\n')
    await expect(detectConflictOperation(repoPath)).resolves.toBe('unknown')
  })

  it('keeps the deletion by staging the removed worktree file', async () => {
    const { repoPath, git } = createDeleteModifyConflict()

    rmSync(join(repoPath, 'gone.txt'))
    await stageFile(repoPath, 'gone.txt')
    await expect(completeMerge(repoPath)).resolves.toEqual({ success: true })

    expect(git('ls-tree', '--name-only', 'HEAD')).toBe('')
    expect(git('log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2)
    await expect(detectConflictOperation(repoPath)).resolves.toBe('unknown')
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
