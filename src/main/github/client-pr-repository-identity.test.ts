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

  function bind(tracked: boolean) {
    git(repo, 'remote', 'add', 'other', 'https://github.com/stranger/other.git')
    if (tracked) {
      git(repo, 'update-ref', 'refs/remotes/fork/feature', 'HEAD')
      git(repo, 'config', 'branch.feature.remote', 'fork')
      git(repo, 'config', 'branch.feature.merge', 'refs/heads/feature')
    } else {
      git(repo, 'config', 'branch.feature.pushRemote', 'fork')
    }
  }

  function forge(name: string | null | undefined, exactName = name, exactBranch = 'feature') {
    const rest = JSON.parse(response().stdout)[0]
    rest.head.repo =
      name === null
        ? null
        : name === undefined
          ? undefined
          : {
              name,
              full_name: `contributor/${name}`,
              owner: { login: 'contributor' },
              html_url: `https://github.com/contributor/${name}`
            }
    rest.html_url = 'https://github.com/stranger/other/pull/42'
    const exact = {
      number: 42,
      title: 'Hydrated review',
      state: 'OPEN',
      url: rest.html_url,
      statusCheckRollup: [],
      updatedAt: '',
      mergeable: 'UNKNOWN',
      headRefName: exactBranch,
      headRefOid: 'head',
      headRepository:
        exactName === null
          ? null
          : exactName === undefined
            ? undefined
            : { name: exactName, nameWithOwner: `contributor/${exactName}` },
      headRepositoryOwner: { login: 'contributor' }
    }
    gh.mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return { stdout: JSON.stringify(exact) }
      }
      if (
        args[0] === 'api' &&
        args[1].startsWith('repos/stranger/other/pulls?head=contributor%3Afeature')
      ) {
        return { stdout: JSON.stringify([rest]) }
      }
      return { stdout: '[]' }
    })
  }

  it.each([false, true])(
    'rejects same-owner wrong-repository positives with tracked=%s',
    async (tracked) => {
      bind(tracked)
      forge('other')
      await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
        kind: 'upstream-error'
      })
      expect(gh.mock.calls.some(([args]) => args[1] === 'view')).toBe(false)
    }
  )

  it.each([false, true])(
    'publishes actual repository after successful hydration with tracked=%s',
    async (tracked) => {
      bind(tracked)
      forge('repo')
      await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
        kind: 'found',
        pr: {
          number: 42,
          title: 'Hydrated review',
          headRepo: { owner: 'contributor', repo: 'repo', host: 'github.com' },
          headRefName: 'feature'
        }
      })
      expect(
        gh.mock.calls.some(
          ([args]) =>
            args[1] === 'view' && args.at(-1).includes('headRepository,headRepositoryOwner')
        )
      ).toBe(true)
    }
  )

  it.each([null, undefined])(
    'keeps incomplete discovery identity %s inconclusive',
    async (name) => {
      bind(true)
      forge(name)
      await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
        kind: 'upstream-error'
      })
    }
  )

  it.each([
    ['other', 'feature'],
    [null, 'feature'],
    ['repo', 'Feature']
  ])('rejects conflicting hydration %s:%s', async (name, branch) => {
    bind(true)
    forge('repo', name, branch as string)
    await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
      kind: 'upstream-error'
    })
    expect(gh.mock.calls.some(([args]) => args[1] === 'view')).toBe(true)
  })

  it.each([null, undefined])(
    'retains explicit exact lookup with unavailable head repository %s',
    async (name) => {
      bind(false)
      forge(name)
      const result = await getPRForBranchOutcome(repo, 'feature', 42)
      expect(result).toMatchObject({ kind: 'found', pr: { number: 42, headRepo: undefined } })
    }
  )

  it('publishes actual explicit ownership instead of expected local repository', async () => {
    bind(false)
    forge('other')
    await expect(getPRForBranchOutcome(repo, 'feature', 42)).resolves.toMatchObject({
      kind: 'found',
      pr: { headRepo: { owner: 'contributor', repo: 'other', host: 'github.com' } }
    })
  })

  it('keeps exact fallback recovery separate from rejected branch discovery', async () => {
    bind(true)
    forge('other')
    await expect(getPRForBranchOutcome(repo, 'feature', null, null, 42)).resolves.toMatchObject({
      kind: 'found',
      pr: { headRepo: { repo: 'other' } }
    })
  })
  it('rejects incomplete successful hydration instead of inventing missing repository identity', async () => {
    bind(true)
    forge('repo')
    const original = gh.getMockImplementation()!
    gh.mockImplementation(async (args: string[]) => {
      const result = await original(args)
      if (args[1] === 'view') {
        const data = JSON.parse(result.stdout)
        data.headRepository = { name: 'repo' }
        delete data.headRepositoryOwner
        return { stdout: JSON.stringify(data) }
      }
      return result
    })
    await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
      kind: 'upstream-error'
    })
  })

  it('retains actual discovery evidence when older CLI hydration omits both head repository fields', async () => {
    bind(true)
    forge('repo')
    const original = gh.getMockImplementation()!
    gh.mockImplementation(async (args: string[]) => {
      const result = await original(args)
      if (args[1] === 'view') {
        const data = JSON.parse(result.stdout)
        delete data.headRepository
        delete data.headRepositoryOwner
        return { stdout: JSON.stringify(data) }
      }
      return result
    })
    await expect(getPRForBranchOutcome(repo, 'feature')).resolves.toMatchObject({
      kind: 'found',
      pr: { headRepo: { owner: 'contributor', repo: 'repo' } }
    })
  })

  it.each([null, 'other'])(
    'publishes REST exact fallback identity %s after GraphQL failure',
    async (name) => {
      bind(false)
      gh.mockImplementation(async (args: string[]) => {
        if (args[0] === 'pr') {
          throw new Error('GraphQL rate limit exceeded')
        }
        const rest = JSON.parse(response().stdout)[0]
        rest.head.repo = name === null ? null : { name, owner: { login: 'contributor' } }
        return { stdout: JSON.stringify(rest) }
      })
      await expect(getPRForBranchOutcome(repo, 'feature', 42)).resolves.toMatchObject({
        kind: 'found',
        pr: { headRepo: name === null ? undefined : { owner: 'contributor', repo: 'other' } }
      })
    }
  )
})
