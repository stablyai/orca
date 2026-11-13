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

type PushCase = {
  name: string
  config: string[][]
  destination: string | null
  pushSucceeds: boolean
  noUpstream?: boolean
  remoteName?: string
}
const cases: PushCase[] = [
  {
    name: 'nothing',
    config: [['push.default', 'nothing']],
    destination: null,
    pushSucceeds: false
  },
  {
    name: 'unmapped refspec',
    config: [['remote.fork.push', 'refs/heads/other:refs/heads/other']],
    destination: null,
    pushSucceeds: true
  },
  {
    name: 'unmapped refspec overrides upstream mode',
    config: [
      ['push.default', 'upstream'],
      ['remote.fork.push', 'refs/heads/other:refs/heads/other']
    ],
    destination: null,
    pushSucceeds: true
  },
  {
    name: 'simple with another upstream branch',
    config: [['push.default', 'simple']],
    destination: null,
    pushSucceeds: false
  },
  {
    name: 'current',
    config: [['push.default', 'current']],
    destination: 'feature',
    pushSucceeds: true
  },
  {
    name: 'explicit mapping overrides nothing',
    config: [
      ['push.default', 'nothing'],
      ['remote.fork.push', 'refs/heads/feature:refs/heads/published']
    ],
    destination: 'published',
    pushSucceeds: true
  },
  {
    name: 'simple without upstream and with distinct origin push URL',
    config: [['push.default', 'simple']],
    destination: null,
    pushSucceeds: false,
    noUpstream: true,
    remoteName: 'origin'
  },
  {
    name: 'named fork push remote without upstream',
    config: [
      ['push.default', 'simple'],
      ['branch.feature.pushRemote', 'fork']
    ],
    destination: 'feature',
    pushSucceeds: true,
    noUpstream: true
  },
  {
    name: 'named origin push remote still lacks upstream',
    config: [
      ['push.default', 'simple'],
      ['branch.feature.pushRemote', 'origin']
    ],
    destination: null,
    pushSucceeds: false,
    noUpstream: true,
    remoteName: 'origin'
  },
  {
    name: 'automatic upstream setup',
    config: [
      ['push.default', 'simple'],
      ['push.autoSetupRemote', 'true']
    ],
    destination: 'feature',
    pushSucceeds: true,
    noUpstream: true,
    remoteName: 'origin'
  },
  {
    name: 'local tracking stays local in current mode',
    config: [
      ['branch.feature.remote', '.'],
      ['branch.feature.merge', 'refs/heads/feature'],
      ['push.default', 'current']
    ],
    destination: null,
    pushSucceeds: true,
    noUpstream: true
  },
  {
    name: 'local tracking rejects a mismatched simple upstream',
    config: [
      ['branch.feature.remote', '.'],
      ['branch.feature.merge', 'refs/heads/other'],
      ['push.default', 'simple']
    ],
    destination: null,
    pushSucceeds: false,
    noUpstream: true
  },
  {
    name: 'merge ref without tracking remote is not a simple upstream',
    config: [
      ['branch.feature.merge', 'refs/heads/feature'],
      ['push.default', 'simple']
    ],
    destination: null,
    pushSucceeds: false,
    noUpstream: true
  },
  {
    name: 'merge ref without tracking remote is not an upstream-mode upstream',
    config: [
      ['branch.feature.merge', 'refs/heads/feature'],
      ['push.default', 'upstream']
    ],
    destination: null,
    pushSucceeds: false,
    noUpstream: true
  },
  {
    name: 'explicit fork publishing overrides local tracking',
    config: [
      ['branch.feature.remote', '.'],
      ['branch.feature.merge', 'refs/heads/other'],
      ['branch.feature.pushRemote', 'fork'],
      ['push.default', 'simple']
    ],
    destination: 'feature',
    pushSucceeds: true,
    noUpstream: true
  },
  {
    name: 'explicit fork publishing works with an orphan merge ref',
    config: [
      ['branch.feature.merge', 'refs/heads/feature'],
      ['branch.feature.pushRemote', 'fork'],
      ['push.default', 'simple']
    ],
    destination: 'feature',
    pushSucceeds: true,
    noUpstream: true
  },
  {
    name: 'local tracking is not an origin fetch-URL alias',
    config: [
      ['remote.origin.url', '.'],
      ['branch.feature.remote', '.'],
      ['branch.feature.merge', 'refs/heads/feature'],
      ['push.default', 'current']
    ],
    destination: null,
    pushSucceeds: true,
    noUpstream: true
  }
]
it.for(cases)(
  'matches real Git publication while keeping discovery usable: $name',
  async (
    { config, destination, pushSucceeds, noUpstream = false, remoteName = 'fork' },
    { skip }
  ) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'push-head-'))
    const repo = path.join(directory, 'checkout')
    const fork = path.join(directory, 'fork.git')
    const base = path.join(directory, 'base.git')
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
      if (config.some(([key]) => key === 'push.autoSetupRemote')) {
        const version = (await run(directory, ['--version'])).stdout.match(
          /git version (\d+)\.(\d+)/
        )
        if (Number(version?.[1]) === 2 && Number(version?.[2]) < 37) {
          skip()
        }
      }
      await run(directory, ['init', '--quiet', '--bare', fork])
      await run(directory, ['init', '--quiet', '--bare', base])
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
      await git(['branch', 'other'])
      await git(['remote', 'add', 'fork', fork])
      await git(['remote', 'add', 'origin', base])
      await git(['remote', 'set-url', '--push', 'origin', fork])
      if (!noUpstream) {
        await git(['config', 'branch.feature.remote', 'fork'])
        await git(['config', 'branch.feature.merge', 'refs/heads/other'])
      }
      for (const [key, value] of config) {
        await git(['config', key, value])
      }
      const configuredHead = await getConfiguredPushHead(repo, 'feature', null, {})
      const source = (await readGitReviewBranchSources(git, ['feature'])).get('feature')
      const push = await run(repo, ['push'])
      expect(push.code === 0, push.stderr).toBe(pushSucceeds)
      if (destination === null) {
        const feature = await run(directory, [
          '--git-dir',
          fork,
          'rev-parse',
          '--verify',
          'refs/heads/feature'
        ])
        expect(feature.code).not.toBe(0)
        // GitLab can still discover a manually published branch despite a disabled plain push.
        expect(source).toMatchObject({
          branchName: 'feature',
          pushBranchName: null
        })
        expect(configuredHead).toBeNull()
      } else {
        expect(push.code, push.stderr).toBe(0)
        expect(configuredHead).toMatchObject({
          headRepo: { owner: 'contributor', repo: 'orca' },
          branch: { remoteName, branchName: destination }
        })
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
