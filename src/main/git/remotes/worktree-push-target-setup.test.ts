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

// `makeRepoExec` plus in-memory `remote.<name>.fetch` / `.orca-created` / `.tagOpt` config,
// mutated the way real `git config` would be (#25703's reuse-with-refspec matrix).
function makeConfigAwareRepoExec(
  remotes: Record<string, string>,
  fetchRefspecsByRemote: Record<string, string[]> = {},
  orcaCreatedRemotes: string[] = []
): {
  exec: ExecMock
  fetchRefspecs: Record<string, string[]>
  tagOptByRemote: Record<string, string>
} {
  const fetchRefspecs: Record<string, string[]> = { ...fetchRefspecsByRemote }
  const tagOptByRemote: Record<string, string> = {}
  const orcaCreated = new Set(orcaCreatedRemotes)
  const exec = vi.fn<GitRemoteExec>(async (args: string[]) => {
    if (args[0] === 'config') {
      const configKey =
        args[1] === '--get-all' ||
        args[1] === '--unset-all' ||
        args[1] === '--add' ||
        args[1] === '--get'
          ? args[2]
          : args[1]
      const fetchMatch = /^remote\.(.+)\.fetch$/.exec(configKey ?? '')
      const markerMatch = /^remote\.(.+)\.orca-created$/.exec(configKey ?? '')
      if (args[1] === '--get-all' && fetchMatch) {
        const values = fetchRefspecs[fetchMatch[1]!] ?? []
        if (values.length === 0) {
          throw new Error('key not found')
        }
        return { stdout: `${values.join('\n')}\n`, stderr: '' }
      }
      if (args[1] === '--unset-all' && fetchMatch) {
        fetchRefspecs[fetchMatch[1]!] = []
        return { stdout: '', stderr: '' }
      }
      if (args[1] === '--add' && fetchMatch) {
        fetchRefspecs[fetchMatch[1]!] = [...(fetchRefspecs[fetchMatch[1]!] ?? []), args[3]!]
        return { stdout: '', stderr: '' }
      }
      if (args[1] === '--get' && markerMatch) {
        if (!orcaCreated.has(markerMatch[1]!)) {
          throw new Error('key not found')
        }
        return { stdout: 'true\n', stderr: '' }
      }
      if (args[1]?.startsWith('remote.') && args[1]?.endsWith('.tagOpt')) {
        tagOptByRemote[args[1]!.slice('remote.'.length, -'.tagOpt'.length)] = args[2]!
        return { stdout: '', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    }
    return makeRepoExec(remotes)(args, REPO)
  })
  return { exec, fetchRefspecs, tagOptByRemote }
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

  describe('prepareWorktreePushTargetWithExec reuse (#25703)', () => {
    it('preserves a reused user-created remote with no marker and only appends its branch (#25703)', async () => {
      const WIDE = '+refs/heads/*:refs/remotes/fork/*'
      const { exec, fetchRefspecs, tagOptByRemote } = makeConfigAwareRepoExec(
        {
          origin: 'git@github.com:stablyai/orca.git',
          fork: FORK_HTTPS
        },
        { fork: [WIDE] }
      )

      await prepareWorktreePushTargetWithExec(
        exec,
        REPO,
        { remoteName: 'pr-contributor-orca', branchName: 'contributor/fix', remoteUrl: FORK_SSH },
        () => false
      )

      expect(fetchRefspecs.fork).toEqual([
        WIDE,
        '+refs/heads/contributor/fix*:refs/remotes/fork/contributor/fix*'
      ])
      // The remote's fetch behavior is the user's; no tagOpt rewrite either.
      expect(tagOptByRemote.fork).toBeUndefined()
    })

    it('keeps the workaround wide refspec when a second branch reuses the same user remote (#25703)', async () => {
      const WIDE = '+refs/heads/*:refs/remotes/fork/*'
      const { exec, fetchRefspecs } = makeConfigAwareRepoExec(
        {
          origin: 'git@github.com:stablyai/orca.git',
          fork: FORK_HTTPS
        },
        { fork: [WIDE, '+refs/heads/a*:refs/remotes/fork/a*'] }
      )

      await prepareWorktreePushTargetWithExec(
        exec,
        REPO,
        { remoteName: 'pr-contributor-orca', branchName: 'b', remoteUrl: FORK_SSH },
        () => false
      )

      expect(fetchRefspecs.fork).toEqual([
        WIDE,
        '+refs/heads/a*:refs/remotes/fork/a*',
        '+refs/heads/b*:refs/remotes/fork/b*'
      ])
    })

    it('still narrows a reused remote Orca created (orca-created marker set)', async () => {
      const { exec, fetchRefspecs, tagOptByRemote } = makeConfigAwareRepoExec(
        {
          origin: 'git@github.com:stablyai/orca.git',
          'pr-contributor-orca': FORK_HTTPS
        },
        { 'pr-contributor-orca': ['+refs/heads/*:refs/remotes/pr-contributor-orca/*'] },
        ['pr-contributor-orca']
      )

      await prepareWorktreePushTargetWithExec(exec, REPO, forkTarget(), () => false)

      expect(fetchRefspecs['pr-contributor-orca']).toEqual([
        '+refs/heads/contributor/fix*:refs/remotes/pr-contributor-orca/contributor/fix*'
      ])
      expect(tagOptByRemote['pr-contributor-orca']).toBe('--no-tags')
    })
  })
})
