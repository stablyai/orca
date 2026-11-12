import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import path from 'node:path'
import { runProcess } from '@orca/process-host'
import { readGitReviewBranchSources } from '../../../../shared/git/remotes/git-review-branch-source'

vi.mock('./tracked-upstream-branch', () => ({
  getTrackedUpstreamBranch: async () => null,
  getReviewBranchSource: async (repoPath: string, branch: string) => {
    const { readGitReviewBranchSources } =
      await import('../../../../shared/git/remotes/git-review-branch-source')
    const { runProcess } = await import('@orca/process-host')
    const { devNull } = await import('node:os')
    const sources = await readGitReviewBranchSources(
      async (args) => {
        const result = await runProcess({
          program: 'git',
          args,
          cwd: repoPath,
          env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' }
        })
        if (result.code !== 0) {
          throw new Error(result.stderr)
        }
        return result
      },
      [branch]
    )
    const source = sources.get(branch)
    if (!source || source instanceof Error) {
      throw source ?? new Error('No review source')
    }
    return source
  }
}))

vi.mock('../../repositories/github-api-repository-remote-probe', () => ({
  getGitHubApiRepositoryForRemote: async () => null,
  // The local bare repository stands in for a verified fork identity; no network is involved.
  getGitHubApiRepositoryForRemoteUrl: async () => ({ owner: 'contributor', repo: 'orca' })
}))

import { getConfiguredPushHead } from './branch-review-heads'

it.each([
  { name: 'nothing', config: [['push.default', 'nothing']], destination: null },
  {
    name: 'unmapped refspec',
    config: [['remote.fork.push', 'refs/heads/other:refs/heads/other']],
    destination: null
  },
  {
    name: 'simple with another upstream branch',
    config: [['push.default', 'simple']],
    destination: null
  },
  { name: 'current', config: [['push.default', 'current']], destination: 'feature' },
  {
    name: 'explicit mapping overrides nothing',
    config: [
      ['push.default', 'nothing'],
      ['remote.fork.push', 'refs/heads/feature:refs/heads/published']
    ],
    destination: 'published'
  }
])(
  'matches real Git publication while keeping discovery usable: $name',
  async ({ config, destination }) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'push-head-'))
    const repo = path.join(directory, 'checkout')
    const fork = path.join(directory, 'fork.git')
    const run = (cwd: string, args: string[]) =>
      runProcess({
        program: 'git',
        args,
        cwd,
        env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' }
      })
    const git = async (args: string[]) => {
      const result = await run(repo, args)
      if (result.code !== 0) {
        throw new Error(result.stderr)
      }
      return result
    }
    try {
      await run(directory, ['init', '--quiet', '--bare', fork])
      await run(directory, ['init', '--quiet', repo])
      await git(['checkout', '-b', 'feature'])
      await git([
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'initial'
      ])
      await git(['remote', 'add', 'fork', fork])
      await git(['config', 'branch.feature.remote', 'fork'])
      await git(['config', 'branch.feature.merge', 'refs/heads/other'])
      for (const [key, value] of config) {
        await git(['config', key, value])
      }
      const push = await run(repo, ['push', '--dry-run'])
      const source = (await readGitReviewBranchSources(git, ['feature'])).get('feature')
      if (destination === null) {
        expect(push.code).not.toBe(0)
        // GitLab can still discover a manually published branch despite a disabled plain push.
        expect(source).toMatchObject({
          branchName: 'feature',
          trackedBranchName: 'other',
          pushBranchName: null
        })
        await expect(getConfiguredPushHead(repo, 'feature', null, {})).resolves.toBeNull()
      } else {
        expect(push.code, push.stderr).toBe(0)
        await expect(getConfiguredPushHead(repo, 'feature', null, {})).resolves.toMatchObject({
          headRepo: { owner: 'contributor', repo: 'orca' },
          branch: { remoteName: 'fork', branchName: destination }
        })
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
