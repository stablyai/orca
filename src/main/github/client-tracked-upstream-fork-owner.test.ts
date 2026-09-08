import type * as GitRunner from '../git/runner'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gh } = vi.hoisted(() => ({ gh: vi.fn() }))
vi.mock('../git/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  ghExecFileAsync: gh
}))
import { getPRForBranchOutcome } from './client/lookup/pr-for-branch-outcome'
import { _resetGitRemoteTopologySnapshotCache } from '../git/git-remote-topology-snapshot'
import { resolveGitHubApiRepositoryCandidates } from './github-api-repository'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function response(owner = 'contributor', branch = 'feature') {
  return {
    stdout: JSON.stringify([
      {
        number: 42,
        title: 'Review',
        state: 'open',
        draft: false,
        html_url: 'https://github.com/canonical/repo/pull/42',
        updated_at: '2026-03-28T00:00:00Z',
        mergeable: true,
        base: { ref: 'main', sha: 'base' },
        head: {
          ref: branch,
          sha: 'head',
          repo: { name: 'repo', owner: { login: owner } }
        }
      }
    ])
  }
}

describe('shipping branch lookup with real Git ownership evidence', () => {
  let repo = ''
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'orca-review-evidence-'))
    vi.stubEnv('HOME', repo)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(repo, 'empty-config'))
    git(repo, 'init', '-q')
    git(
      repo,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture'
    )
    git(repo, 'checkout', '-qb', 'feature')
    git(repo, 'remote', 'add', 'origin', 'https://github.com/canonical/repo.git')
    git(repo, 'remote', 'add', 'fork', 'https://github.com/contributor/repo.git')
    _resetGitRemoteTopologySnapshotCache()
    gh.mockReset().mockResolvedValue({ stdout: '[]', stderr: '' })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(repo, { recursive: true, force: true })
  })

  it('keeps inferred future push ownership inconclusive after successful empty responses', async () => {
    git(repo, 'update-ref', 'refs/remotes/fork/feature', 'HEAD')
    git(repo, 'config', 'branch.feature.pushRemote', 'origin')
    await expect(
      resolveGitHubApiRepositoryCandidates(repo, null, {}, 'feature')
    ).resolves.toMatchObject({
      head: {
        provenance: 'branch-push-remote',
        confidence: 'inferred',
        repository: { owner: 'canonical' }
      }
    })
    await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
      kind: 'upstream-error',
      errorType: 'repo_unavailable'
    })
    expect(
      gh.mock.calls.some(([args]) => args.join(' ').includes('head=canonical%3Afeature'))
    ).toBe(true)
  })

  it('finds the no-upstream fork from matching remote branch evidence', async () => {
    git(repo, 'update-ref', 'refs/remotes/fork/feature', 'HEAD')
    gh.mockImplementation(async (args: string[]) =>
      args.join(' ').includes('head=contributor%3Afeature') ? response() : { stdout: '[]' }
    )
    await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
      kind: 'found',
      pr: { number: 42 }
    })
  })

  it.each(['feature', 'published'])(
    'uses captured tracked upstream %s without a second Git scan',
    async (branch) => {
      git(repo, 'update-ref', `refs/remotes/fork/${branch}`, 'HEAD')
      git(repo, 'config', 'branch.feature.remote', 'fork')
      git(repo, 'config', 'branch.feature.merge', `refs/heads/${branch}`)
      gh.mockImplementation(async (args: string[]) =>
        args.join(' ').includes(`head=contributor%3A${branch}`)
          ? response('contributor', branch)
          : { stdout: '[]' }
      )
      await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
        kind: 'found',
        pr: { number: 42 }
      })
    }
  )

  it.each([
    ['origin/team', 'refs/remotes/origin/team/published'],
    ['remotes', 'refs/custom/published'],
    ['fork', 'refs/heads/tracking/published']
  ])('retains configured tracked owner %s through custom ref %s', async (remote, tracking) => {
    if (remote !== 'fork') {
      git(repo, 'remote', 'rename', 'fork', remote)
    }
    git(repo, 'config', `remote.${remote}.fetch`, `+refs/heads/published:${tracking}`)
    git(repo, 'update-ref', tracking, 'HEAD')
    git(repo, 'config', 'branch.feature.remote', remote)
    git(repo, 'config', 'branch.feature.merge', 'refs/heads/published')
    git(repo, 'tag', `${remote}/published`)
    gh.mockImplementation(async (args: string[]) =>
      args.join(' ').includes('head=contributor%3Apublished')
        ? response('contributor', 'published')
        : { stdout: '[]' }
    )
    await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
      kind: 'found',
      pr: { number: 42 }
    })
  })

  it('accepts an empty tracked-owner lookup as no PR', async () => {
    git(repo, 'update-ref', 'refs/remotes/fork/feature', 'HEAD')
    git(repo, 'config', 'branch.feature.remote', 'fork')
    git(repo, 'config', 'branch.feature.merge', 'refs/heads/feature')
    await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({ kind: 'no-pr' })
  })

  it('uses the distinct push URL owner in the actual REST request', async () => {
    git(repo, 'remote', 'set-url', '--push', 'origin', 'https://github.com/contributor/repo.git')
    git(repo, 'config', 'branch.feature.pushRemote', 'origin')
    gh.mockImplementation(async (args: string[]) =>
      args.join(' ').includes('head=contributor%3Afeature') ? response() : { stdout: '[]' }
    )
    await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
      kind: 'found',
      pr: { number: 42 }
    })
  })

  it('keeps multiple push destinations inconclusive', async () => {
    git(repo, 'remote', 'set-url', '--push', 'origin', 'https://github.com/contributor/repo.git')
    git(
      repo,
      'remote',
      'set-url',
      '--add',
      '--push',
      'origin',
      'https://github.com/another/repo.git'
    )
    git(repo, 'config', 'branch.feature.pushRemote', 'origin')
    await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
      kind: 'upstream-error',
      errorType: 'repo_unavailable'
    })
  })

  it.each(['ambiguous', 'multiple-push', 'unresolved'])(
    'rejects an unrelated positive with %s owner evidence',
    async (topology) => {
      if (topology === 'multiple-push') {
        git(
          repo,
          'remote',
          'set-url',
          '--push',
          'origin',
          'https://github.com/contributor/repo.git'
        )
        git(
          repo,
          'remote',
          'set-url',
          '--add',
          '--push',
          'origin',
          'https://github.com/another/repo.git'
        )
        git(repo, 'config', 'branch.feature.pushRemote', 'origin')
        git(repo, 'update-ref', 'refs/remotes/fork/feature', 'HEAD')
      } else if (topology === 'unresolved') {
        git(repo, 'remote', 'remove', 'origin')
        git(repo, 'remote', 'remove', 'fork')
      }
      const foreign = {
        number: 99,
        title: 'Unrelated same-name branch',
        state: 'OPEN',
        url: 'https://github.com/canonical/repo/pull/99',
        updatedAt: '',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
        headRefName: 'feature',
        headRefOid: 'unrelated',
        headRepositoryOwner: { login: 'stranger' }
      }
      gh.mockImplementation(async (args: string[]) => ({
        stdout: JSON.stringify(args[1] === 'list' ? [foreign] : foreign)
      }))
      await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
        kind: 'upstream-error',
        errorType: 'repo_unavailable'
      })
      expect(gh.mock.calls.some(([args]) => args[0] === 'pr' && args[1] === 'list')).toBe(false)
    }
  )

  it('recovers a true tracked owner through ambiguous push intent', async () => {
    git(repo, 'remote', 'set-url', '--push', 'origin', 'https://github.com/contributor/repo.git')
    git(
      repo,
      'remote',
      'set-url',
      '--add',
      '--push',
      'origin',
      'https://github.com/another/repo.git'
    )
    git(repo, 'config', 'branch.feature.pushRemote', 'origin')
    git(repo, 'update-ref', 'refs/remotes/fork/published', 'HEAD')
    git(repo, 'config', 'branch.feature.remote', 'fork')
    git(repo, 'config', 'branch.feature.merge', 'refs/heads/published')
    gh.mockImplementation(async (args: string[]) =>
      args.join(' ').includes('head=contributor%3Apublished')
        ? response('contributor', 'published')
        : { stdout: '[]' }
    )
    await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
      kind: 'found',
      pr: { number: 42, headRepo: { owner: 'contributor' } }
    })
  })

  it('recovers an explicit fallback number after ambiguous branch ownership', async () => {
    gh.mockImplementation(async (args: string[]) => ({
      stdout: JSON.stringify(
        args[0] === 'pr' && args[1] === 'view'
          ? {
              number: 42,
              title: 'Exact recovery',
              state: 'OPEN',
              url: 'https://github.com/canonical/repo/pull/42',
              updatedAt: '',
              mergeable: 'MERGEABLE',
              statusCheckRollup: [],
              headRefName: 'feature'
            }
          : []
      )
    }))
    await expect(getPRForBranchOutcome(repo, 'feature', null, null, 42)).resolves.toMatchObject({
      kind: 'found',
      pr: { number: 42 }
    })
  })

  it('preserves a linked exact-number positive lookup', async () => {
    gh.mockResolvedValue({
      stdout: JSON.stringify({
        number: 42,
        title: 'Exact review',
        state: 'OPEN',
        isDraft: false,
        url: 'https://github.com/canonical/repo/pull/42',
        updatedAt: '2026-03-28T00:00:00Z',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
        baseRefName: 'main',
        headRefName: 'feature',
        baseRefOid: 'base',
        headRefOid: 'head'
      })
    })
    await expect(getPRForBranchOutcome(repo, 'feature', 42)).resolves.toMatchObject({
      kind: 'found',
      pr: { number: 42 }
    })
  })
})
