import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitPushTarget } from '../../shared/worktree/types'
import { getUpstreamStatus } from './upstream'

// Why: on-demand remote materialization (#17828) defers `git remote add` for a
// fork PR to first push/pull/fetch/fast-forward, so an unpublished review's
// status must be read against a pushTarget whose remote was never created.
// This exercises the real `rev-parse --verify --quiet` failure path -- a
// fake/mocked git can't reproduce its exact exit-code/stderr shape, which is
// exactly what `getPublishTargetStatus`'s missing-ref fallback depends on.
describe('getUpstreamStatus with a deferred (not-yet-materialized) fork remote', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('reports the graceful "publish" state instead of 0 ahead/0 behind', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-deferred-fork-remote-'))
    tempPaths.push(repoPath)
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' })

    git('init', '--quiet')
    git('config', 'user.name', 'Orca Test')
    git('config', 'user.email', 'orca@example.test')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'core.hooksPath', '.git/no-hooks')
    writeFileSync(join(repoPath, 'fixture.txt'), 'base\n')
    git('add', 'fixture.txt')
    git('commit', '-m', 'base')
    git('branch', '-M', 'contributor/fix')

    // Simulates a fork-PR review worktree right after create: pushTarget
    // metadata is persisted, but `pr-contributor-orca` was never added as a
    // remote because materialization is deferred to first use.
    const pushTarget: GitPushTarget = {
      remoteName: 'pr-contributor-orca',
      branchName: 'contributor/fix',
      remoteUrl: 'git@github.com:contributor/orca.git'
    }

    const status = await getUpstreamStatus(repoPath, pushTarget)

    expect(status).toEqual({
      hasUpstream: false,
      upstreamName: 'pr-contributor-orca/contributor/fix',
      ahead: 0,
      behind: 0,
      hasConfiguredPushTarget: true
    })
  })
})
