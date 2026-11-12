import { mkdtemp, mkdir, realpath, rename, rm, symlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { listLocalBranches } from '../../worktrees/checkout/checkout'
import { _resetBranchRefSnapshotsForTests } from './branch-ref-snapshot'
import { searchBaseRefDetails } from '../resolution/repo-base-ref-search'
import { searchRemoteRefPage } from '../resolution/repo-remote-ref-search'
import { RuntimeRepositoryRefQueries } from '../../../runtime/repositories/runtime-repository-ref-queries'
import {
  repoDispatcher,
  makeRequest
} from '../../../runtime/rpc/methods/projects/repo-rpc.test-fixture'
import type { Repo } from '../../../../shared/repo-types'
import { drainSubprocessSpawnStats } from '../../../diagnostics/main-thread-churn-probe'
import { beginGitRefMutation, subscribeGitRefChanges } from '../git-ref-change-signal'
import { resolveBranchSnapshotIdentity } from './branch-ref-snapshot-identity'

const roots: string[] = []
const git = async (cwd: string, ...args: string[]) =>
  (await gitExecFileAsync(args, { cwd })).stdout.trim()

afterEach(async () => {
  vi.unstubAllEnvs()
  _resetBranchRefSnapshotsForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('discovers the physical parent of a symlink to a repository subdirectory', async () => {
  const { root } = await fixture()
  const parent = await mkdtemp(join(tmpdir(), 'orca-ref-alias-'))
  roots.push(parent)
  await mkdir(join(root, 'nested'))
  await symlink(join(root, 'nested'), join(parent, 'alias'), 'junction')
  expect(await searchBaseRefDetails(join(parent, 'alias'), 'collision', 20)).toEqual([
    { refName: 'refs/heads/collision', localBranchName: 'collision' }
  ])
})

it.each([10, 100])(
  'loads one population for %i refs and filters repeated entrypoint searches without children',
  async (population) => {
    const { root, tagOid } = await fixture()
    await gitExecFileAsync(['update-ref', '--stdin'], {
      cwd: root,
      stdin: Array.from(
        { length: population },
        (_, i) => `create refs/heads/scale-${i} ${tagOid}\n`
      ).join('')
    })
    const repo: Repo = { id: 'scale', path: root, displayName: 'scale', badgeColor: '', addedAt: 0 }
    const runtime = new RuntimeRepositoryRefQueries({ resolveRepo: async () => repo })
    vi.stubEnv('ORCA_MAIN_THREAD_DIAGNOSTICS', '1')
    drainSubprocessSpawnStats()
    expect((await searchBaseRefDetails(root, 'scale-', 30)).length).toBe(Math.min(population, 30))
    expect(drainSubprocessSpawnStats()['git for-each-ref']?.count).toBe(1)
    // Queries only need an existing generation; each surface's limit is a bounded projection.
    for (let query = 0; query < 10; query++) {
      await searchBaseRefDetails(root, `scale-${query}`, 30)
      await runtime.search('scale', 'scale-', 20)
      await runtime.search('scale', 'absent', 20, true, 'remote')
    }
    expect(drainSubprocessSpawnStats()).toEqual({})
    const identity = await resolveBranchSnapshotIdentity(root, {})
    const end = beginGitRefMutation(identity!.commonDir)
    await searchBaseRefDetails(root, 'scale-', 30)
    drainSubprocessSpawnStats()
    await runtime.search('scale', 'scale-1', 20)
    await searchBaseRefDetails(root, 'absent', 30)
    expect(drainSubprocessSpawnStats()).toEqual({})
    end()
  }
)

async function fixture(): Promise<{ root: string; branchOid: string; tagOid: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-branch-snapshot-'))
  roots.push(root)
  await git(root, 'init', '-q', '-b', 'main')
  const commit = () =>
    git(
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture'
    )
  await commit()
  const branchOid = await git(root, 'rev-parse', 'HEAD')
  await git(root, 'branch', 'collision')
  await commit()
  const tagOid = await git(root, 'rev-parse', 'HEAD')
  await git(root, 'tag', 'collision')
  await git(root, 'remote', 'add', 'origin', 'https://example.invalid/repo.git')
  await git(root, 'remote', 'add', 'team/fork', 'https://example.invalid/fork.git')
  await gitExecFileAsync(['update-ref', '--stdin'], {
    cwd: root,
    stdin: [
      'refs/heads/Feature/emoji😀',
      'refs/heads/origin/main',
      'refs/remotes/origin/main',
      'refs/remotes/origin/feature/HEAD',
      'refs/remotes/team/fork/release/topic'
    ]
      .map((ref) => `create ${ref} ${tagOid}\n`)
      .join('')
  })
  await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  return { root, branchOid, tagOid }
}

it('searches readable branch names while keeping branch actions unambiguous', async () => {
  const { root, branchOid, tagOid } = await fixture()
  expect(branchOid).not.toBe(tagOid)
  expect(await searchBaseRefDetails(root, 'feature/EMOJI', 30)).toEqual([
    { refName: 'refs/heads/Feature/emoji😀', localBranchName: 'Feature/emoji😀' }
  ])
  expect(await searchBaseRefDetails(root, 'refs/heads', 30)).toEqual([])
  expect(await searchBaseRefDetails(root, 'collision', 20)).toEqual([
    { refName: 'refs/heads/collision', localBranchName: 'collision' }
  ])
  expect(await git(root, 'rev-parse', 'refs/heads/collision')).toBe(branchOid)
  expect(await searchBaseRefDetails(root, 'origin/main', 20)).toEqual([
    { refName: 'refs/heads/origin/main', localBranchName: 'origin/main' },
    { refName: 'refs/remotes/origin/main', localBranchName: 'main' }
  ])
  expect(await searchRemoteRefPage(root, '', 2)).toEqual({
    refDetails: [
      { refName: 'refs/remotes/origin/feature/HEAD', localBranchName: 'feature/HEAD' },
      { refName: 'refs/remotes/origin/main', localBranchName: 'main' }
    ],
    truncated: true
  })
})

it('keeps ordinary branches available to a client without qualified-ref support', async () => {
  const { root } = await fixture()
  const repo: Repo = {
    id: 'snapshot-test',
    path: root,
    displayName: 'fixture',
    badgeColor: '',
    addedAt: 0
  }
  const queries = new RuntimeRepositoryRefQueries({ resolveRepo: async () => repo })
  const dispatcher = repoDispatcher({
    getRuntimeId: () => 'snapshot-test',
    searchRepoRefs: (repo, query, limit, qualified, namespace) =>
      queries.search(repo, query, limit ?? 25, qualified, namespace)
  })
  const response = await dispatcher.dispatch(
    makeRequest('repo.searchRefs', {
      repo: 'snapshot-test',
      query: '',
      limit: 20
    }),
    { clientCapabilities: [] }
  )
  const result = z
    .object({ result: z.object({ refs: z.array(z.string()) }) })
    .parse(response).result
  expect(result.refs).toContain('main')
  expect(result.refs).not.toContain('collision')
  expect(result.refs).not.toContain('refs/heads/collision')
  expect(result.refs).not.toContain('refs/heads/Feature/emoji😀')
  expect(result.refs.some((ref) => ref.startsWith('refs/'))).toBe(false)
  await git(root, 'update-ref', 'refs/heads/origin/a', 'HEAD')
  await git(root, 'update-ref', 'refs/remotes/origin/a', 'HEAD')
  await git(root, 'update-ref', 'refs/remotes/origin/b', 'HEAD')
  const remoteResponse = await dispatcher.dispatch(
    makeRequest('repo.searchRefs', {
      repo: 'snapshot-test',
      query: '',
      limit: 1,
      namespace: 'remote'
    }),
    { clientCapabilities: [] }
  )
  expect(
    z
      .object({ result: z.object({ refs: z.array(z.string()), truncated: z.boolean() }) })
      .parse(remoteResponse).result
  ).toEqual({ refs: [], truncated: true })
})

it('fences prior results even when our mutating command fails', async () => {
  const { root } = await fixture()
  expect(await searchBaseRefDetails(root, 'external', 20)).toEqual([])
  await promisify(execFile)('git', ['branch', 'external'], { cwd: root })
  await expect(git(root, 'branch', 'main')).rejects.toThrow()
  expect(await searchBaseRefDetails(root, 'external', 20)).toEqual([
    { refName: 'refs/heads/external', localBranchName: 'external' }
  ])
})

it('shares linked checkout branches while reading current branch and occupancy per request', async () => {
  const { root } = await fixture()
  const linkedParent = await mkdtemp(join(tmpdir(), 'orca-branch-linked-'))
  roots.push(linkedParent)
  const linked = join(linkedParent, 'checkout')
  await git(root, 'worktree', 'add', '-qb', 'other', linked)
  const nested = join(linked, 'nested')
  await mkdir(nested)
  expect(await searchBaseRefDetails(nested, 'collision', 20)).toEqual([
    { refName: 'refs/heads/collision', localBranchName: 'collision' }
  ])
  const mainBranches = await listLocalBranches(root)
  const linkedBranches = await listLocalBranches(nested)
  expect(mainBranches.current).toBe('main')
  expect(mainBranches.branches[0]).toBe('main')
  expect(linkedBranches.current).toBe('other')
  expect(linkedBranches.branches[0]).toBe('other')
  expect(linkedBranches.worktreePaths?.other).toBe(await realpath(linked))
  await git(root, 'branch', 'fresh')
  expect(await searchBaseRefDetails(nested, 'fresh', 20)).toEqual([
    { refName: 'refs/heads/fresh', localBranchName: 'fresh' }
  ])
})

it('fences all live repositories for own writes from linked, known and unknown paths', async () => {
  const { root } = await fixture()
  const { root: other } = await fixture()
  const linkedParent = await realpath(await mkdtemp(join(tmpdir(), 'orca-ref-scope-')))
  roots.push(linkedParent)
  const linked = join(linkedParent, 'checkout')
  await git(root, 'worktree', 'add', '-qb', 'linked-scope', linked)
  expect((await listLocalBranches(root)).worktreePaths?.['linked-scope']).toBe(linked)
  await searchBaseRefDetails(other, '', 20)
  const a = await resolveBranchSnapshotIdentity(root, {})
  const b = await resolveBranchSnapshotIdentity(other, {})
  const events: string[] = []
  const offA = subscribeGitRefChanges(a!.commonDir, () => events.push('a'))
  const offB = subscribeGitRefChanges(b!.commonDir, () => events.push('b'))
  try {
    await git(linked, 'branch', 'linked-one')
    expect(events.splice(0)).toEqual(['a', 'b', 'a', 'b'])
    await git(linked, 'branch', 'linked-two')
    expect(events.splice(0)).toEqual(['a', 'b', 'a', 'b'])
    await git(other, 'branch', 'other-one')
    expect(events.splice(0)).toEqual(['a', 'b', 'a', 'b'])
    const unknown = await mkdtemp(join(tmpdir(), 'orca-ref-unknown-'))
    roots.push(unknown)
    await expect(git(unknown, 'branch', 'fails')).rejects.toThrow()
    expect(events).toEqual(['a', 'b', 'a', 'b'])
  } finally {
    offA()
    offB()
  }
})

it('uses each linked checkout effective remote config against the shared raw population', async () => {
  const { root, tagOid } = await fixture()
  const linkedParent = await mkdtemp(join(tmpdir(), 'orca-ref-config-'))
  roots.push(linkedParent)
  const linked = join(linkedParent, 'checkout')
  await git(root, 'worktree', 'add', '-qb', 'config-context', linked)
  await git(root, 'config', 'extensions.worktreeConfig', 'true')
  await git(
    linked,
    'config',
    '--worktree',
    'remote.checkout/fork.url',
    'https://example.invalid/context.git'
  )
  await git(root, 'update-ref', 'refs/remotes/checkout/fork/HEAD', tagOid)
  expect(await searchBaseRefDetails(root, 'checkout/fork/HEAD', 20)).toEqual([
    { refName: 'refs/remotes/checkout/fork/HEAD', localBranchName: 'fork/HEAD' }
  ])
  expect(await searchBaseRefDetails(linked, 'checkout/fork/HEAD', 20)).toEqual([])
})

it('rebinds a repository replaced at the same common-directory path', async () => {
  const { root } = await fixture()
  expect(await searchBaseRefDetails(root, 'collision', 20)).toEqual([
    { refName: 'refs/heads/collision', localBranchName: 'collision' }
  ])
  await rename(join(root, '.git'), join(root, '.git-old'))
  const externalGit = (...args: string[]) => promisify(execFile)('git', args, { cwd: root })
  await externalGit('init', '-q', '-b', 'main')
  await externalGit(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'replacement'
  )
  await externalGit('branch', 'replacement')
  expect(await searchBaseRefDetails(root, 'collision', 20)).toEqual([])
  expect(await searchBaseRefDetails(root, 'replacement', 20)).toEqual([
    { refName: 'refs/heads/replacement', localBranchName: 'replacement' }
  ])
})
