import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isGitWorktreeMutationInFlight,
  trackGitWorktreeMutation
} from './git-worktree-mutation-state'

let root = ''
let repo = ''

describe('Git worktree mutation tracking', () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-git-mutation-')))
    repo = join(root, 'repo')
    await mkdir(join(repo, '.git'), { recursive: true })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reports a queued mutation until it settles, through path aliases', async () => {
    const alias = join(root, 'alias')
    await symlink(repo, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const release = trackGitWorktreeMutation(['rebase', '--abort'], { cwd: alias })
    await expect(isGitWorktreeMutationInFlight(repo, {})).resolves.toBe(true)
    release()
    await expect(isGitWorktreeMutationInFlight(repo, {})).resolves.toBe(false)
  })

  it('ignores reads, transfers, and conflict previews that cannot change the worktree', async () => {
    const releases = [
      trackGitWorktreeMutation(['status', '--porcelain=v2'], { cwd: repo }),
      trackGitWorktreeMutation(['-c', 'gc.auto=0', 'fetch', 'origin'], { cwd: repo }),
      trackGitWorktreeMutation(['--git-dir', join(repo, '.git'), 'fetch', 'origin'], {
        cwd: root
      }),
      trackGitWorktreeMutation(['push', 'origin', 'HEAD'], { cwd: repo }),
      trackGitWorktreeMutation(['merge-tree', '--write-tree', 'HEAD', 'main'], { cwd: repo })
    ]
    try {
      await expect(isGitWorktreeMutationInFlight(repo, {})).resolves.toBe(false)
    } finally {
      releases.forEach((release) => release())
    }
  })

  it('does not report a mutation that finishes while its path is being resolved', async () => {
    const release = trackGitWorktreeMutation(['rebase', '--continue'], { cwd: repo })
    const checking = isGitWorktreeMutationInFlight(repo, {})
    release()
    await expect(checking).resolves.toBe(false)
  })

  it('isolates mutations by workspace and WSL distro', async () => {
    const releaseOther = trackGitWorktreeMutation(['pull'], { cwd: root })
    const releaseWsl = trackGitWorktreeMutation(['pull'], { cwd: repo, wslDistro: 'Ubuntu' })
    try {
      await expect(isGitWorktreeMutationInFlight(repo, {})).resolves.toBe(false)
    } finally {
      releaseOther()
      releaseWsl()
    }
  })

  it.each([{ prefix: ['-c', 'gc.auto=0', '-C'] }, { prefix: ['--git-dir'] }])(
    'scopes by leading Git options',
    async ({ prefix }) => {
      const directory = prefix.includes('-C') ? repo : join(repo, '.git')
      const release = trackGitWorktreeMutation([...prefix, directory, 'rebase', '--continue'], {
        cwd: root
      })
      try {
        await expect(isGitWorktreeMutationInFlight(repo, {})).resolves.toBe(true)
      } finally {
        release()
      }
    }
  )
})
