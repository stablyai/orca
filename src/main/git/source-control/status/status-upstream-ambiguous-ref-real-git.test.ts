import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { afterEach, expect, it } from 'vitest'
import { getStatus } from './status-read'
import { invalidateGitReadCaches } from '../git-read-cache-invalidation'

let root: string | undefined

afterEach(async () => {
  invalidateGitReadCaches()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('follows the published branch when a local branch shares the upstream name', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'orca-status-upstream-ambiguous-'))
  const repo = path.join(root, 'repo')
  const git = (args: string[], cwd = repo): void => {
    const result = runProcessSync({ program: 'git', args, cwd })
    expect(result.code, result.stderr).toBe(0)
  }
  git(['init', '-q', '--bare', path.join(root, 'origin.git')], root)
  git(['init', '-q', repo], root)
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test User'])
  git(['config', 'commit.gpgSign', 'false'])
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(['commit', '-q', '--allow-empty', '-m', 'base'])
  git(['remote', 'add', 'origin', path.join(root, 'origin.git')])
  git(['push', '-q', 'origin', 'main'])
  git(['checkout', '-q', '-b', 'feature'])
  git(['commit', '-q', '--allow-empty', '-m', 'published'])
  git(['push', '-q', 'origin', 'feature'])
  git(['commit', '-q', '--allow-empty', '-m', 'local'])
  // Legacy worktrees track origin/main while publishing feature; the local branch makes Git print remotes/origin/main.
  git(['branch', '-q', '--set-upstream-to=origin/main'])
  git(['branch', 'origin/main', 'main'])

  const status = await getStatus(repo, { includeLineStats: false })

  expect(status.upstreamStatus).toMatchObject({
    hasUpstream: true,
    upstreamName: 'origin/feature',
    ahead: 1,
    behind: 0
  })
})
