import { describe, expect, it, vi, type Mock } from 'vitest'
import type { GitPushTarget } from '../../../shared/worktree/types'
import type { GitRemoteExec } from './worktree-push-target-cleanup'
import { prepareWorktreePushTargetWithExec } from './worktree-push-target-setup'

type ExecMock = Mock<GitRemoteExec>

const REPO = '/repo-root'
const FORK_SSH = 'git@github.com:contributor/orca.git'
const FORK_HTTPS = 'https://github.com/contributor/orca.git'

export function renderRemoteVerbose(remotes: Record<string, string>): string {
  return Object.entries(remotes)
    .flatMap(([name, url]) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`])
    .join('\n')
}

// Stateful Git mock preserves remote additions and defaults HEAD to a real local branch.
function makeRepoExec(
  remotes: Record<string, string>,
  checkedOutBranch = 'local-branch'
): ExecMock {
  return vi.fn<GitRemoteExec>(async (args: string[]) => {
    if (args[0] === 'symbolic-ref' && args[1] === '--quiet' && args[2] === 'HEAD') {
      return { stdout: `refs/heads/${checkedOutBranch}\n`, stderr: '' }
    }
    if (args[0] === 'remote' && args.length === 1) {
      return { stdout: Object.keys(remotes).join('\n'), stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === '-v' && args.length === 2) {
      return { stdout: renderRemoteVerbose(remotes), stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const url = remotes[args[2]!]
      if (!url) {
        throw new Error(`No such remote ${args[2]}`)
      }
      return { stdout: `${url}\n`, stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'add') {
      remotes[args.at(-2)!] = args.at(-1)!
      return { stdout: '', stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'remove') {
      delete remotes[args[2]!]
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}

function callsMatching(exec: ExecMock, head: string[]): string[][] {
  return exec.mock.calls
    .map(([args]) => args)
    .filter((args) => head.every((part, i) => args[i] === part))
}

function forkTarget(overrides: Partial<GitPushTarget> = {}): GitPushTarget {
  return {
    remoteName: 'pr-contributor-orca',
    branchName: 'contributor/fix',
    remoteUrl: FORK_SSH,
    ...overrides
  }
}

describe('prepareWorktreePushTargetWithExec rollback', () => {
  it('removes the remote it just added when the fetch fails', async () => {
    const remotes: Record<string, string> = { origin: 'git@github.com:stablyai/orca.git' }
    const exec = vi.fn<GitRemoteExec>(async (args: string[]) => {
      if (args[0] === 'fetch') {
        throw new Error('network unreachable')
      }
      return makeRepoExec(remotes)(args, REPO)
    })

    await expect(
      prepareWorktreePushTargetWithExec(
        exec,
        REPO,
        { remoteName: 'pr-contributor-orca', branchName: 'contributor/fix', remoteUrl: FORK_SSH },
        () => false
      )
    ).rejects.toThrow('network unreachable')

    expect(callsMatching(exec, ['remote', 'remove'])).toEqual([
      ['remote', 'remove', 'pr-contributor-orca']
    ])
    expect(remotes).not.toHaveProperty('pr-contributor-orca')
  })

  it('keeps a reused remote a sibling worktree owns when the fetch fails', async () => {
    const remotes: Record<string, string> = {
      origin: 'git@github.com:stablyai/orca.git',
      'pr-contributor-orca': FORK_HTTPS
    }
    const exec = vi.fn<GitRemoteExec>(async (args: string[]) => {
      if (args[0] === 'fetch') {
        throw new Error('network unreachable')
      }
      return makeRepoExec(remotes)(args, REPO)
    })

    await expect(
      prepareWorktreePushTargetWithExec(exec, REPO, forkTarget(), () => true)
    ).rejects.toThrow('network unreachable')

    expect(callsMatching(exec, ['remote', 'remove'])).toEqual([])
    expect(remotes['pr-contributor-orca']).toBe(FORK_HTTPS)
  })
})
