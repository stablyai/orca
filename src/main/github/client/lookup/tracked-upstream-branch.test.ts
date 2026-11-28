import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as GitExecFile from '../../../git/command-runner/git-exec-file'
import type { GitExecOptions } from '../../../git/command-runner/git-exec-options'
import { removeTempDirs } from '../../../../shared/testing/remove-temp-dirs.test-support'
import {
  createLinkedWorktreeFixture,
  fixtureGit,
  FORK_URL,
  ORIGIN_URL,
  restoreGitConfigEnv,
  type LinkedWorktreeFixture
} from './tracked-upstream-worktrees.test-support'

const gitCalls = vi.hoisted((): { args: string[]; cwd: string }[] => [])

vi.mock('../../../git/command-runner/git-exec-file', async (importOriginal) => {
  const actual = await importOriginal<typeof GitExecFile>()
  return {
    ...actual,
    gitExecFileAsync: (args: string[], options: GitExecOptions) => {
      gitCalls.push({ args, cwd: options.cwd })
      return actual.gitExecFileAsync(args, options)
    }
  }
})

import { getReviewBranchSource, getTrackedUpstreamBranch } from './tracked-upstream-branch'
import {
  trackedUpstreamSnapshotCache,
  trackedUpstreamSnapshotGenerations,
  trackedUpstreamSnapshotInFlight
} from './tracked-upstream-cache'

const roots: string[] = []
const savedEnv = {
  global: process.env.GIT_CONFIG_GLOBAL,
  nosystem: process.env.GIT_CONFIG_NOSYSTEM
}
let fixture: LinkedWorktreeFixture

function callsIn(cwd: string): string[] {
  return gitCalls.filter((call) => call.cwd === cwd).map((call) => call.args.slice(0, 2).join(' '))
}

beforeEach(async () => {
  trackedUpstreamSnapshotCache.clear()
  trackedUpstreamSnapshotInFlight.clear()
  trackedUpstreamSnapshotGenerations.clear()
  fixture = await createLinkedWorktreeFixture(roots)
  gitCalls.length = 0
})

afterEach(async () => {
  vi.useRealTimers()
  restoreGitConfigEnv(savedEnv)
  await removeTempDirs(roots.splice(0))
})

const mainSource = { remoteName: 'origin', urls: [ORIGIN_URL], branchName: 'feature' }
const linkedSource = { remoteName: 'fork', urls: [FORK_URL], branchName: 'feature' }

describe('tracked upstream lookups follow each linked worktree’s effective config', () => {
  it('observes host Git when the buffered runner reads a real linked worktree', async () => {
    const runtimes: string[] = []
    const result = await GitExecFile.gitExecFileAsync(['rev-parse', '--is-inside-work-tree'], {
      cwd: fixture.worktreePath,
      observeGitRuntime: (runsIn) => runtimes.push(runsIn)
    })
    expect(result.stdout.trim()).toBe('true')
    expect(runtimes).toEqual(['host'])
  })

  it('resolves each worktree’s own upstream and review source, main first', async () => {
    const { repoPath, worktreePath } = fixture
    await expect(getTrackedUpstreamBranch(repoPath, 'feature')).resolves.toEqual({
      remoteName: 'origin',
      branchName: 'feature'
    })
    await expect(getReviewBranchSource(repoPath, 'feature')).resolves.toEqual(mainSource)
    await expect(getTrackedUpstreamBranch(worktreePath, 'feature')).resolves.toEqual({
      remoteName: 'fork',
      branchName: 'feature'
    })
    await expect(getReviewBranchSource(worktreePath, 'feature')).resolves.toEqual(linkedSource)
  })

  it('resolves each worktree’s own source, linked first, and serves both warm without Git', async () => {
    const { repoPath, worktreePath } = fixture
    await expect(getReviewBranchSource(worktreePath, 'feature')).resolves.toEqual(linkedSource)
    await expect(getReviewBranchSource(repoPath, 'feature')).resolves.toEqual(mainSource)
    expect(callsIn(worktreePath)).toEqual([
      'for-each-ref --format=%(refname)%00%(upstream)',
      'config --list',
      'remote -v'
    ])
    expect(callsIn(repoPath)).toHaveLength(3)

    gitCalls.length = 0
    await expect(getReviewBranchSource(repoPath, 'feature')).resolves.toEqual(mainSource)
    await expect(getReviewBranchSource(worktreePath, 'feature')).resolves.toEqual(linkedSource)
    await expect(getTrackedUpstreamBranch(worktreePath, 'feature')).resolves.toEqual({
      remoteName: 'fork',
      branchName: 'feature'
    })
    expect(gitCalls).toEqual([])
  })

  it('keeps concurrent lookups from sibling worktrees on separate probes', async () => {
    const { repoPath, worktreePath } = fixture
    const [linked, main, linkedUpstream, mainUpstream] = await Promise.all([
      getReviewBranchSource(worktreePath, 'feature'),
      getReviewBranchSource(repoPath, 'feature'),
      getTrackedUpstreamBranch(worktreePath, 'feature'),
      getTrackedUpstreamBranch(repoPath, 'feature')
    ])
    expect(linked).toEqual(linkedSource)
    expect(main).toEqual(mainSource)
    expect(linkedUpstream).toEqual({ remoteName: 'fork', branchName: 'feature' })
    expect(mainUpstream).toEqual({ remoteName: 'origin', branchName: 'feature' })
  })

  it('re-probes only the worktree whose own config.worktree changed', async () => {
    const { repoPath, worktreePath } = fixture
    await getReviewBranchSource(repoPath, 'feature')
    await getReviewBranchSource(worktreePath, 'feature')
    fixtureGit(worktreePath, 'config', '--worktree', 'branch.feature.pushRemote', 'origin')
    gitCalls.length = 0

    await expect(getReviewBranchSource(repoPath, 'feature')).resolves.toEqual(mainSource)
    expect(gitCalls).toEqual([])
    const changed = await getReviewBranchSource(worktreePath, 'feature')
    expect(changed.remoteName).toBe('origin')
    expect(callsIn(worktreePath)).toHaveLength(3)
  })

  it('follows a worktree’s own HEAD for onbranch includes', async () => {
    const { root, repoPath, worktreePath } = fixture
    const include = join(root, 'feature.inc')
    await writeFile(include, '[remote]\n\tpushDefault = fork\n')
    fixtureGit(repoPath, 'config', 'includeIf.onbranch:feature.path', include)
    fixtureGit(repoPath, 'branch', 'topic')
    fixtureGit(repoPath, 'branch', 'other')

    await expect(getReviewBranchSource(repoPath, 'topic')).resolves.toMatchObject({
      remoteName: 'origin'
    })
    await expect(getReviewBranchSource(worktreePath, 'topic')).resolves.toMatchObject({
      remoteName: 'fork'
    })

    fixtureGit(worktreePath, 'switch', '--quiet', 'other')
    gitCalls.length = 0
    await expect(getReviewBranchSource(worktreePath, 'topic')).resolves.toMatchObject({
      remoteName: 'origin'
    })
    await expect(getReviewBranchSource(repoPath, 'topic')).resolves.toMatchObject({
      remoteName: 'origin'
    })
    expect(callsIn(repoPath)).toEqual([])
  })

  it('keeps unsigned global config on the TTL until a forced refresh', async () => {
    const { repoPath, globalConfigPath } = fixture
    fixtureGit(repoPath, 'branch', 'topic')
    await expect(getReviewBranchSource(repoPath, 'topic')).resolves.toMatchObject({
      remoteName: 'origin'
    })
    await writeFile(globalConfigPath, '[remote]\n\tpushDefault = fork\n')

    await expect(getReviewBranchSource(repoPath, 'topic')).resolves.toMatchObject({
      remoteName: 'origin'
    })
    await expect(getReviewBranchSource(repoPath, 'topic', null, {}, true)).resolves.toMatchObject({
      remoteName: 'fork'
    })
  })

  it('forces past a warm entry for both upstream and review lookups', async () => {
    const { worktreePath } = fixture
    await getTrackedUpstreamBranch(worktreePath, 'feature')
    await getReviewBranchSource(worktreePath, 'feature')
    gitCalls.length = 0

    await getTrackedUpstreamBranch(worktreePath, 'feature', null, {}, true)
    expect(callsIn(worktreePath)).toEqual(['for-each-ref --format=%(refname)%00%(upstream)'])
    gitCalls.length = 0
    await getReviewBranchSource(worktreePath, 'feature', null, {}, true)
    expect(callsIn(worktreePath)).toHaveLength(3)
  })

  it('counts one upstream probe, then one full probe for the review upgrade', async () => {
    const { worktreePath } = fixture
    await getTrackedUpstreamBranch(worktreePath, 'feature')
    await getReviewBranchSource(worktreePath, 'feature')
    expect(callsIn(worktreePath)).toEqual([
      'for-each-ref --format=%(refname)%00%(upstream)',
      'for-each-ref --format=%(refname)%00%(upstream)',
      'config --list',
      'remote -v'
    ])
  })

  it('does not cache a failed probe', async () => {
    const notRepo = await realpath(await mkdtemp(join(tmpdir(), 'orca-tracked-upstream-none-')))
    roots.push(notRepo)
    await expect(getTrackedUpstreamBranch(notRepo, 'feature')).resolves.toBeNull()
    await expect(getTrackedUpstreamBranch(notRepo, 'feature')).resolves.toBeNull()
    await expect(getReviewBranchSource(notRepo, 'feature')).rejects.toThrow(
      'Cannot establish the branch review source'
    )
    expect(callsIn(notRepo)).toHaveLength(3)
    expect(trackedUpstreamSnapshotCache.size).toBe(0)
  })
})
