import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import { findWindowsGitRefusals, windowsGitWorktreeVerdict } from './wsl-move-windows-git-worktrees'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wsl-move-wingit-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

const verdict = (path: string) => windowsGitWorktreeVerdict(path, 'Ubuntu')

describe('windowsGitWorktreeVerdict', () => {
  it('refuses worktree records Git for Windows wrote, stale ones included', async () => {
    const repo = join(root, 'app')
    write(join(repo, '.git', 'worktrees', 'linux', 'gitdir'), '/home/me/trees/linux/.git\n')
    expect(await verdict(repo)).toBe('ok')
    write(join(repo, '.git', 'worktrees', 'gone', 'gitdir'), 'W:/home/me/trees/gone/.git\n')
    expect(await verdict(repo)).toBe('windows-git-worktrees')
  })

  it('checks a bare repo through its own records', async () => {
    const bare = join(root, 'bare.git')
    write(join(bare, 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(join(bare, 'objects'))
    write(join(bare, 'worktrees', 'x', 'gitdir'), 'W:/home/me/x/.git\n')
    expect(await verdict(bare)).toBe('windows-git-worktrees')
  })

  it('refuses a `.git` file that names a Windows path, a worktree or a separate Git folder', async () => {
    const tree = join(root, 'tree')
    write(join(tree, '.git'), 'gitdir: W:/home/me/app/.git/worktrees/tree\n')
    expect(await verdict(tree)).toBe('windows-git-dir')
  })

  it('follows a separate Git folder with no `commondir` to its own records', async () => {
    const repo = join(root, 'separate')
    write(join(repo, '.git'), 'gitdir: ../store.git\n')
    write(join(root, 'store.git', 'worktrees', 'x', 'gitdir'), 'W:/home/me/x/.git\n')
    expect(await verdict(repo)).toBe('windows-git-worktrees')
  })

  it('fails closed on records it cannot read; only a folder outside Git passes', async () => {
    expect(await verdict(join(root, 'plain'))).toBe('ok')
    const gitdirDir = join(root, 'a')
    mkdirSync(join(gitdirDir, '.git', 'worktrees', 'x', 'gitdir'), { recursive: true })
    await expect(verdict(gitdirDir)).rejects.toThrow()
    const commonDirDir = join(root, 'b')
    write(join(commonDirDir, '.git'), 'gitdir: ../bgit\n')
    mkdirSync(join(root, 'bgit', 'commondir'), { recursive: true })
    await expect(verdict(commonDirDir)).rejects.toThrow()
    const worktreesFile = join(root, 'c')
    write(join(worktreesFile, '.git', 'worktrees'), 'not a folder')
    await expect(verdict(worktreesFile)).rejects.toThrow()
  })
})

describe('worktree records Git ignores', () => {
  it('passes over a stray file and an entry with no `gitdir`, as Git does', async () => {
    const repo = join(root, 'stray')
    write(join(repo, '.git', 'worktrees', 'notes.txt'), 'x')
    write(join(repo, '.git', 'worktrees', 'half', 'HEAD'), 'ref: refs/heads/x\n')
    write(join(repo, '.git', 'worktrees', 'ok', 'gitdir'), '/home/me/ok/.git\n')
    expect(await verdict(repo)).toBe('ok')
  })

  it('aborts the reads it started once the check times out', async () => {
    let seen: AbortSignal | undefined
    const refusals = await findWindowsGitRefusals(
      [{ id: 'slow', path: 'W:\\slow', displayName: 'slow', badgeColor: '#000', addedAt: 0 }],
      'Ubuntu',
      [{ letter: 'W', share: '\\\\wsl.localhost\\Ubuntu' }],
      (_path, _distro, signal) => {
        seen = signal
        return new Promise(() => {})
      },
      10
    )
    expect(Object.fromEntries(refusals)).toEqual({ slow: 'git-unreadable' })
    expect(seen?.aborted).toBe(true)
  })
})

describe('findWindowsGitRefusals', () => {
  const repo = (id: string, path: string): Repo => ({
    id,
    path,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0
  })
  const W = { letter: 'W', share: '\\\\wsl.localhost\\Ubuntu' }

  it('reads mapped-drive repos through the share, failing closed on errors and timeouts', async () => {
    const checked: string[] = []
    const refusals = await findWindowsGitRefusals(
      [
        repo('win', 'W:\\home\\me\\win'),
        repo('clean', 'W:\\home\\me\\clean'),
        repo('broken', 'W:\\home\\me\\broken'),
        repo('hung', 'W:\\home\\me\\hung'),
        repo('unc', '\\\\wsl.localhost\\Ubuntu\\home\\me\\unc')
      ],
      'Ubuntu',
      [W],
      async (path) => {
        checked.push(path)
        if (path.endsWith('broken')) {
          throw new Error('EACCES')
        }
        if (path.endsWith('hung')) {
          return new Promise(() => {})
        }
        return path.endsWith('win') ? 'windows-git-worktrees' : 'ok'
      },
      20
    )
    expect(Object.fromEntries(refusals)).toEqual({
      win: 'windows-git-worktrees',
      broken: 'git-unreadable',
      hung: 'git-unreadable'
    })
    expect(checked).toContain('\\\\wsl.localhost\\Ubuntu\\home\\me\\win')
    expect(checked.some((path) => path.startsWith('W:'))).toBe(false)
    expect(checked).not.toContain('\\\\wsl.localhost\\Ubuntu\\home\\me\\unc')
  })
})
