import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitPushTarget } from '../../shared/worktree/types'
const { runner } = vi.hoisted(() => ({ runner: vi.fn() }))
vi.mock('./runner', () => ({ gitExecFileAsync: runner }))
import { getUpstreamStatus } from './upstream'

// Real Git verifies missing-ref exit/stderr handling before a fork remote is materialized.
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
    const home = join(repoPath, 'home')
    mkdirSync(home)
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
      ),
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_GLOBAL: join(home, 'empty'),
      GIT_CONFIG_NOSYSTEM: '1'
    }
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repoPath, env, encoding: 'utf8' })
    runner.mockImplementation(async (args: string[], options: { cwd: string }) => ({
      stdout: execFileSync('git', args, { cwd: options.cwd, env, encoding: 'utf8' })
    }))

    git('init', '--quiet')
    git('config', 'user.name', 'Orca Test')
    git('config', 'user.email', 'orca@example.test')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'core.hooksPath', '.git/no-hooks')
    writeFileSync(join(repoPath, 'fixture.txt'), 'base\n')
    git('add', 'fixture.txt')
    git('commit', '-m', 'base')
    git('branch', '-M', 'contributor/fix')

    // Persist a push target without adding its deferred remote.
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
