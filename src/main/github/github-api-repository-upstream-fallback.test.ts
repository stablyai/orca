import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetOriginGitHubApiRepositoryCache,
  resolveIssueGitHubApiRepositorySource
} from './github-api-repository'
import { resolvePrWorkItemSource } from './client/list/work-item-list-request'
import { _resetOwnerRepoCache } from './gh-utils'

// Why: #16474 — the 'upstream' issue-source preference must fall back to
// `origin` when a repo has no `upstream` remote, instead of hard-failing on
// git's "No such remote" exit. These tests run real `git remote` commands
// against a throwaway repo (no gh, no mocked git runner) so a future change to
// the "no such remote" matching in `isStableMissingGitRemoteError` /
// `getOwnerRepoForRemote` can't silently reintroduce the hard-fail the way a
// fully-mocked resolver test would miss.
describe('resolveIssueGitHubApiRepositorySource / resolvePrWorkItemSource — upstream fallback (real git)', () => {
  let repoPath: string

  beforeEach(async () => {
    _resetOriginGitHubApiRepositoryCache()
    _resetOwnerRepoCache()
    repoPath = await mkdtemp(join(tmpdir(), 'orca-upstream-fallback-'))
    execFileSync('git', ['init', '-q'], { cwd: repoPath })
  })

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true })
  })

  it('falls back to origin when preference is upstream and no upstream remote exists (HTTPS origin)', async () => {
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/octocat/Hello-World.git'], {
      cwd: repoPath
    })

    const result = await resolveIssueGitHubApiRepositorySource(repoPath, 'upstream')

    expect(result).toEqual({
      source: { owner: 'octocat', repo: 'Hello-World', host: 'github.com' },
      fellBack: true
    })
  })

  it('falls back to origin when preference is upstream and no upstream remote exists (SSH origin)', async () => {
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:octocat/Hello-World.git'], {
      cwd: repoPath
    })

    const result = await resolveIssueGitHubApiRepositorySource(repoPath, 'upstream')

    expect(result).toEqual({
      source: { owner: 'octocat', repo: 'Hello-World', host: 'github.com' },
      fellBack: true
    })
  })

  it('resolves upstream directly when the upstream remote exists', async () => {
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/octocat/fork.git'], {
      cwd: repoPath
    })
    execFileSync(
      'git',
      ['remote', 'add', 'upstream', 'https://github.com/octocat/Hello-World.git'],
      { cwd: repoPath }
    )

    const result = await resolveIssueGitHubApiRepositorySource(repoPath, 'upstream')

    expect(result).toEqual({
      source: { owner: 'octocat', repo: 'Hello-World', host: 'github.com' },
      fellBack: false
    })
  })

  it('resolves to null without throwing when the repo has no remotes at all', async () => {
    const result = await resolveIssueGitHubApiRepositorySource(repoPath, 'upstream')

    expect(result).toEqual({ source: null, fellBack: false })
  })

  it('falls back PR-side resolution to origin the same way', async () => {
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/octocat/Hello-World.git'], {
      cwd: repoPath
    })

    const result = await resolvePrWorkItemSource(repoPath, 'upstream')

    expect(result).toEqual({
      source: { owner: 'octocat', repo: 'Hello-World', host: 'github.com' },
      originCandidate: { owner: 'octocat', repo: 'Hello-World', host: 'github.com' },
      upstreamCandidate: null
    })
  })
})
