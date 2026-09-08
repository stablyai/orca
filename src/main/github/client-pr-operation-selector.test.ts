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
import { resolveGitHubApiRepositoryCandidates } from './github-api-repository'
import { _resetGitRemoteTopologySnapshotCache } from '../git/git-remote-topology-snapshot'

const canonical = 'https://github.com/canonical/repo.git'
const contributor = 'https://github.com/contributor/repo.git'

describe('literal Git operation selectors through shipping review discovery', () => {
  let repo = ''
  function git(...args: string[]) {
    return execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      timeout: 10_000
    }).trim()
  }
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'orca-selector-'))
    vi.stubEnv('HOME', repo)
    vi.stubEnv('ORCA_E2E_HOME_DIR', repo)
    vi.stubEnv('ORCA_E2E_USER_DATA_DIR', join(repo, 'user-data'))
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(repo, 'empty-config'))
    git('init', '-q')
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture'
    )
    git('checkout', '-qb', 'feature')
    git('remote', 'add', 'origin', canonical)
    git('remote', 'set-url', '--push', 'origin', contributor)
    git('config', 'branch.feature.merge', 'refs/heads/feature')
    _resetGitRemoteTopologySnapshotCache()
    gh.mockReset()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(repo, { recursive: true, force: true })
  })
  function forge(owner: string) {
    const identity = {
      name: 'repo',
      nameWithOwner: `${owner}/repo`,
      owner: { login: owner },
      html_url: `https://github.com/${owner}/repo`
    }
    gh.mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          stdout: JSON.stringify({
            number: 91,
            title: `Hydrated ${owner}`,
            state: 'OPEN',
            url: 'https://github.com/canonical/repo/pull/91',
            headRefName: 'feature',
            headRefOid: 'sha',
            headRepository: identity,
            headRepositoryOwner: { login: owner },
            statusCheckRollup: [],
            updatedAt: '',
            mergeable: 'UNKNOWN',
            baseRefName: 'main'
          })
        }
      }
      if (args[0] === 'api' && args[1].includes(`head=${owner}%3Afeature`)) {
        return {
          stdout: JSON.stringify([
            {
              number: 91,
              title: owner,
              state: 'open',
              html_url: 'https://github.com/canonical/repo/pull/91',
              head: { ref: 'feature', sha: 'sha', repo: identity },
              base: { ref: 'main' }
            }
          ])
        }
      }
      return { stdout: '[]' }
    })
  }
  it.each(['branch.feature.pushRemote', 'remote.pushDefault', 'branch.feature.remote'])(
    'preserves literal %s through both discovery and successful hydration',
    async (key) => {
      git('config', key, canonical)
      forge('contributor')
      await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
        kind: key === 'branch.feature.remote' ? 'no-pr' : 'upstream-error'
      })
      expect(gh.mock.calls.some(([args]) => args[1] === 'view')).toBe(false)
      forge('canonical')
      await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
        kind: 'found',
        pr: {
          title: 'Hydrated canonical',
          headRepo: { owner: 'canonical', repo: 'repo' }
        }
      })
    }
  )
  it.each(['branch.feature.pushRemote', 'remote.pushDefault'])(
    'retains named %s pushurl semantics',
    async (key) => {
      git('config', key, 'origin')
      forge('contributor')
      await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
        kind: 'found',
        pr: { headRepo: { owner: 'contributor' } }
      })
    }
  )
  it.each(['insteadOf', 'pushInsteadOf'])(
    'lets execution-host Git expand literal %s without borrowing pushurl',
    async (rewrite) => {
      git('config', `url.${canonical}.${rewrite}`, 'shortcut:repo')
      git('config', 'branch.feature.pushRemote', 'shortcut:repo')
      forge('canonical')
      await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
        kind: 'found',
        pr: { headRepo: { owner: 'canonical' } }
      })
    }
  )
  it('retains repeated rewrite values and longest-prefix selection', async () => {
    git('config', '--add', `url.${canonical}.pushInsteadOf`, 'shortcut:repo')
    git('config', '--add', `url.${canonical}.pushInsteadOf`, 'another:repo')
    git('config', `url.https://github.com/wrong/.pushInsteadOf`, 'shortcut:')
    git('config', 'branch.feature.pushRemote', 'shortcut:repo')
    forge('canonical')
    await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
      kind: 'found',
      pr: { headRepo: { owner: 'canonical' } }
    })
  })
  it('does not fall through an explicit non-provider selector to origin', async () => {
    git('config', 'branch.feature.pushRemote', './local-repository')
    forge('contributor')
    await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
      kind: 'upstream-error'
    })
  })
  it('keeps upstream selection in the fetch direction', async () => {
    git('config', 'branch.feature.remote', 'origin')
    const result = await resolveGitHubApiRepositoryCandidates(repo, null, {}, 'feature')
    expect(result.headRepo).toMatchObject({ owner: 'canonical' })
  })
})
