import { execFileSync } from 'child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, posix } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureLocalNestedWorktreeRootIgnored,
  ensureRemoteNestedWorktreeRootIgnored
} from './nested-worktree-exclude'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('ensureLocalNestedWorktreeRootIgnored', () => {
  it('adds .worktrees to git info exclude without dirtying tracked ignores', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'orca-nested-worktrees-'))
    tempDirs.push(repoPath)
    execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' })

    await ensureLocalNestedWorktreeRootIgnored(repoPath)
    await ensureLocalNestedWorktreeRootIgnored(repoPath)
    await mkdir(join(repoPath, '.worktrees', 'feature'), { recursive: true })
    await writeFile(join(repoPath, '.worktrees', 'feature', 'file.txt'), 'nested\n', 'utf8')

    const exclude = await readFile(join(repoPath, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.match(/^\.worktrees\/$/gm)).toHaveLength(1)
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf8' })
    ).toBe('')
  })
})

describe('ensureRemoteNestedWorktreeRootIgnored', () => {
  it('updates the remote repo info exclude once', async () => {
    const excludePath = posix.join('/remote/repo', '.git', 'info', 'exclude')
    const gitProvider = {
      exec: vi.fn().mockResolvedValue({ stdout: '.git/info/exclude\n', stderr: '' })
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({ content: 'build/\n', isBinary: false }),
      writeFile: vi.fn()
    }

    await ensureRemoteNestedWorktreeRootIgnored('/remote/repo', gitProvider, fsProvider)

    expect(gitProvider.exec).toHaveBeenCalledWith(
      ['rev-parse', '--git-path', 'info/exclude'],
      '/remote/repo'
    )
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      excludePath,
      'build/\n.worktrees/\n'
    )
  })
})
