import { listIssues } from '../gitlab/issues'
import type * as GitRunner from './runner'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetGitOperationRemoteRoleCache } from './git-operation-remote-roles'
import {
  _resetOriginGitHubApiRepositoryCache,
  resolveGitHubApiRepositoryCandidates
} from '../github/github-api-repository'
import {
  _resetProjectRefCache,
  getProjectRefForRemote,
  resolveIssueSource
} from '../gitlab/gitlab-project-ref-resolution'

vi.mock('./runner', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  glabExecFileAsync: vi.fn(async () => {
    throw new Error('auth unavailable')
  })
}))

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim()
}

describe('operation remote roles through shipping forge consumers', () => {
  let repoPath = ''

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'orca-operation-remotes-'))
    vi.stubEnv('HOME', repoPath)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(repoPath, 'empty-config'))
    git(repoPath, ['init'])
    git(repoPath, [
      '-c',
      'user.name=Orca Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'init'
    ])
    git(repoPath, ['switch', '-c', 'feature'])
    _resetGitOperationRemoteRoleCache()
    _resetOriginGitHubApiRepositoryCache()
    _resetProjectRefCache()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('finds a no-upstream fork branch from its matching remote-tracking tip across rename', async () => {
    git(repoPath, ['remote', 'add', 'origin', 'https://github.com/stablyai/orca.git'])
    git(repoPath, ['remote', 'add', 'fork', 'https://github.com/contributor/orca.git'])
    git(repoPath, ['update-ref', 'refs/remotes/fork/feature', 'HEAD'])

    await expect(
      resolveGitHubApiRepositoryCandidates(repoPath, null, {}, 'feature')
    ).resolves.toMatchObject({
      headRepo: { owner: 'contributor', repo: 'orca', host: 'github.com' }
    })

    git(repoPath, ['remote', 'rename', 'fork', 'personal'])
    _resetGitOperationRemoteRoleCache()
    _resetOriginGitHubApiRepositoryCache()
    await expect(
      resolveGitHubApiRepositoryCandidates(repoPath, null, {}, 'feature')
    ).resolves.toMatchObject({
      headRepo: { owner: 'contributor', repo: 'orca', host: 'github.com' }
    })
  })

  it('resolves a sole nonstandard GitLab issue source', async () => {
    git(repoPath, ['remote', 'add', 'company', 'git@gitlab.com:stablyai/orca.git'])

    await expect(resolveIssueSource(repoPath, 'auto', ['gitlab.com'])).resolves.toEqual({
      source: { host: 'gitlab.com', path: 'stablyai/orca' },
      fellBack: false
    })
  })

  it('does not choose between two plausible nonstandard GitLab issue sources', async () => {
    git(repoPath, ['remote', 'add', 'company', 'git@gitlab.com:stablyai/orca.git'])
    git(repoPath, ['remote', 'add', 'mirror', 'git@gitlab.com:mirror/orca.git'])

    await expect(resolveIssueSource(repoPath, 'auto', ['gitlab.com'])).resolves.toEqual({
      source: null,
      fellBack: false,
      ambiguousRemoteNames: ['company', 'mirror']
    })
  })
  it('keeps two GitLab projects ambiguous before and after conventional remote rename', async () => {
    git(repoPath, ['remote', 'add', 'origin', 'https://gitlab.com/a/repo.git'])
    git(repoPath, ['remote', 'add', 'mirror', 'https://gitlab.com/b/repo.git'])
    await expect(resolveIssueSource(repoPath, 'auto', ['gitlab.com'])).resolves.toMatchObject({
      source: null,
      ambiguousRemoteNames: ['mirror', 'origin']
    })
    git(repoPath, ['remote', 'rename', 'origin', 'company'])
    await expect(resolveIssueSource(repoPath, 'auto', ['gitlab.com'])).resolves.toMatchObject({
      source: null,
      ambiguousRemoteNames: ['company', 'mirror']
    })
  })

  it('resolves a new captured URL even when the old name has a positive provider cache entry', async () => {
    git(repoPath, ['remote', 'add', 'company', 'https://gitlab.com/old/repo.git'])
    await getProjectRefForRemote(repoPath, 'company', ['gitlab.com'])
    await expect(resolveIssueSource(repoPath, 'auto', ['gitlab.com'])).resolves.toMatchObject({
      source: { path: 'old/repo' }
    })
    git(repoPath, ['remote', 'set-url', 'company', 'https://gitlab.com/new/repo.git'])
    await expect(resolveIssueSource(repoPath, 'auto', ['gitlab.com'])).resolves.toMatchObject({
      source: { path: 'new/repo' }
    })
  })

  it('keeps an unknown auth-failed project candidate plausible', async () => {
    git(repoPath, ['remote', 'add', 'company', 'https://gitlab.com/a/repo.git'])
    git(repoPath, ['remote', 'add', 'mirror', 'https://unverified.example/b/repo.git'])
    await expect(resolveIssueSource(repoPath, 'auto', ['gitlab.com'])).resolves.toMatchObject({
      source: null,
      ambiguousRemoteNames: ['company', 'mirror']
    })
  })

  it('does exclude a verified local non-provider remote', async () => {
    git(repoPath, ['remote', 'add', 'company', 'https://gitlab.com/a/repo.git'])
    git(repoPath, ['remote', 'add', 'local', repoPath])
    await expect(resolveIssueSource(repoPath, 'auto', ['gitlab.com'])).resolves.toMatchObject({
      source: { path: 'a/repo' }
    })
  })

  it('preserves case-sensitive branch subsections and normalizes URL-valued push configuration', async () => {
    git(repoPath, ['remote', 'add', 'origin', 'https://github.com/canonical/repo.git'])
    git(repoPath, ['remote', 'add', 'fork', 'https://github.com/contributor/repo.git'])
    git(repoPath, ['config', 'BRANCH.feature.PUSHREMOTE', 'https://github.com/canonical/repo.git'])
    git(repoPath, ['config', 'branch.Feature.pushRemote', 'fork'])
    await expect(
      resolveGitHubApiRepositoryCandidates(repoPath, null, {}, 'feature')
    ).resolves.toMatchObject({
      headRepo: { owner: 'canonical' },
      head: { provenance: 'branch-push-remote' }
    })
    await expect(
      resolveGitHubApiRepositoryCandidates(repoPath, null, {}, 'Feature')
    ).resolves.toMatchObject({
      headRepo: { owner: 'contributor' }
    })
  })

  it('keeps explicit conventional preferences with two valid projects', async () => {
    git(repoPath, ['remote', 'add', 'origin', 'https://gitlab.com/a/repo.git'])
    git(repoPath, ['remote', 'add', 'upstream', 'https://gitlab.com/b/repo.git'])
    await expect(resolveIssueSource(repoPath, 'origin', ['gitlab.com'])).resolves.toMatchObject({
      source: { path: 'a/repo' }
    })
    await expect(resolveIssueSource(repoPath, 'upstream', ['gitlab.com'])).resolves.toMatchObject({
      source: { path: 'b/repo' }
    })
  })
  it('surfaces ambiguity through the actual issue-list consumer', async () => {
    git(repoPath, ['remote', 'add', 'origin', 'https://gitlab.com/a/repo.git'])
    git(repoPath, ['remote', 'add', 'mirror', 'https://gitlab.com/b/repo.git'])
    await expect(listIssues(repoPath)).resolves.toMatchObject({
      items: [],
      error: { type: 'validation_error' }
    })
  })
})
