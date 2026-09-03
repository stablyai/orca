/**
 * Push-target resolution decides which remote a plain `git push` hits, and a wrong
 * answer is not recoverable by retrying. The relay and the desktop used to carry
 * identical ~160-line copies of it; they now share one implementation.
 *
 * These tests script one repository's Git config and require `git.push` over the real
 * relay dispatcher and the desktop's `gitPush` to emit the *same push argv*, plus the
 * argv each case is supposed to produce — so a second implementation on either side
 * fails here even if it is wrong in the same direction on both.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))

vi.mock('../main/git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { gitPush } from '../main/git/remote'
import { RelayContext } from './context'
import { GitHandler } from './git-handler'
import { createMockDispatcher, type RelayDispatcher } from './git-handler-test-setup'

const WORKTREE_PATH = '/worktree'

type GitConfigFixture = {
  /** Empty means detached HEAD: `symbolic-ref --quiet --short HEAD` prints nothing. */
  branch: string
  merge?: string
  branchRemote?: string
  pushRemote?: string
  pushDefault?: string
  base?: string
  /** remote name -> fetch URL, as `git remote -v` prints it. */
  remotes?: Record<string, string>
}

type GitSpyTarget = {
  git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>
}

/** One scripted repository, driven identically by both hosts. */
function scriptGit(fixture: GitConfigFixture) {
  const configValues = new Map<string, string>()
  const put = (key: string, value: string | undefined): void => {
    if (value !== undefined) {
      configValues.set(key, value)
    }
  }
  put(`branch.${fixture.branch}.merge`, fixture.merge)
  put(`branch.${fixture.branch}.remote`, fixture.branchRemote)
  put(`branch.${fixture.branch}.pushRemote`, fixture.pushRemote)
  put(`branch.${fixture.branch}.base`, fixture.base)
  put('remote.pushDefault', fixture.pushDefault)

  const calls: string[][] = []
  return {
    calls,
    run: async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      calls.push(args)
      if (args[0] === 'symbolic-ref') {
        return { stdout: `${fixture.branch}\n`, stderr: '' }
      }
      if (args[0] === 'config' && args[1] === '--get') {
        const value = configValues.get(args[2] ?? '')
        // Why throw: `git config --get` exits 1 for a missing key, and the resolver's
        // fallback chain reads that rejection, not an empty string.
        if (value === undefined) {
          throw Object.assign(new Error('missing config key'), { code: 1 })
        }
        return { stdout: `${value}\n`, stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === '-v') {
        const lines = Object.entries(fixture.remotes ?? {}).flatMap(([name, url]) => [
          `${name}\t${url} (fetch)`,
          `${name}\t${url} (push)`
        ])
        return { stdout: `${lines.join('\n')}\n`, stderr: '' }
      }
      if (args[0] === 'push') {
        return { stdout: '', stderr: '' }
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    }
  }
}

function pushArgv(calls: string[][]): string[] {
  const push = calls.find((args) => args[0] === 'push')
  if (!push) {
    throw new Error('no push command was issued')
  }
  return push
}

async function pushOverRelay(fixture: GitConfigFixture): Promise<string[]> {
  const dispatcher = createMockDispatcher()
  const handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
  const script = scriptGit(fixture)
  vi.spyOn(handler as unknown as GitSpyTarget, 'git').mockImplementation((args) => script.run(args))
  await dispatcher.callRequest('git.push', { worktreePath: WORKTREE_PATH })
  return pushArgv(script.calls)
}

async function pushLocally(fixture: GitConfigFixture): Promise<string[]> {
  const script = scriptGit(fixture)
  gitExecFileAsyncMock.mockImplementation((args: string[]) => script.run(args))
  await gitPush(WORKTREE_PATH)
  return pushArgv(script.calls)
}

async function expectSamePushArgv(fixture: GitConfigFixture, expected: string[]): Promise<void> {
  const relayArgv = await pushOverRelay(fixture)
  const localArgv = await pushLocally(fixture)
  expect(relayArgv).toEqual(localArgv)
  expect(localArgv).toEqual(expected)
}

const FIRST_PUBLISH = ['push', '--set-upstream', 'origin', 'HEAD']

beforeEach(() => {
  gitExecFileAsyncMock.mockReset()
})

describe('relay/desktop push-target parity', () => {
  it('sends a review branch to the fork its pushDefault names', async () => {
    await expectSamePushArgv(
      {
        branch: 'review/pr-1738',
        merge: 'refs/heads/contributor/fix',
        branchRemote: 'fork',
        pushDefault: 'fork'
      },
      ['push', '--set-upstream', 'fork', 'HEAD:contributor/fix']
    )
  })

  it('refuses to inherit origin/main as a destination for a differently named branch', async () => {
    // branch.merge belongs to branch.remote; a branch tracking origin/main must
    // first-publish under its own name rather than push onto main.
    await expectSamePushArgv(
      {
        branch: 'feature/fix',
        merge: 'refs/heads/main',
        branchRemote: 'origin'
      },
      FIRST_PUBLISH
    )
  })

  it('refuses a pushDefault fork whose branch.remote names a different remote', async () => {
    await expectSamePushArgv(
      {
        branch: 'review/pr-1738',
        merge: 'refs/heads/contributor/fix',
        branchRemote: 'origin',
        pushDefault: 'fork'
      },
      FIRST_PUBLISH
    )
  })

  it('refuses when branch.base names the same remote branch as branch.merge', async () => {
    await expectSamePushArgv(
      {
        branch: 'feature/fix',
        merge: 'refs/heads/release',
        branchRemote: 'fork',
        pushRemote: 'fork',
        base: 'fork/release'
      },
      FIRST_PUBLISH
    )
  })

  it('resolves a URL-valued pushRemote back to its remote name', async () => {
    await expectSamePushArgv(
      {
        branch: 'review/pr-1738',
        merge: 'refs/heads/contributor/fix',
        branchRemote: 'git@example.invalid:contributor/repo.git',
        pushRemote: 'git@example.invalid:contributor/repo.git',
        remotes: {
          origin: 'git@example.invalid:upstream/repo.git',
          fork: 'git@example.invalid:contributor/repo.git'
        }
      },
      ['push', '--set-upstream', 'fork', 'HEAD:contributor/fix']
    )
  })

  it('treats a local-repository remote as no configured target', async () => {
    await expectSamePushArgv(
      {
        branch: 'feature/fix',
        merge: 'refs/heads/feature/fix',
        branchRemote: '.'
      },
      FIRST_PUBLISH
    )
  })

  it('first-publishes a branch with no configured remote at all', async () => {
    await expectSamePushArgv(
      { branch: 'feature/fix', merge: 'refs/heads/feature/fix' },
      FIRST_PUBLISH
    )
  })
})
