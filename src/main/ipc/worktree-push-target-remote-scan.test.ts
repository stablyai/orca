// Why: `findRemoteForUrl` used to run `git remote` and then one serial
// `git remote get-url` per remote. These tests pin both halves of the fix: the
// subprocess count at 58 remotes, and result-for-result parity with the old scan
// across the remote shapes a real repo produces.

import { describe, expect, it } from 'vitest'
import { parseGitHubOwnerRepo } from '../github/gh-utils'
import { findRemoteForUrl } from './worktree-push-target-setup'
import type { GitRemoteExec } from './worktree-push-target-cleanup'

const SSH_FORK = 'git@github.com:contributor/orca.git'
const HTTPS_FORK = 'https://github.com/contributor/orca.git'
const GITLAB_FORK = 'https://gitlab.com/contributor/orca.git'
const UPSTREAM = 'https://github.com/stablyai/orca.git'

type RemoteRow = { name: string; fetchUrl: string; pushUrl?: string }

type CountingExec = GitRemoteExec & { spawns: string[][] }

function makeExec(remotes: readonly RemoteRow[]): CountingExec {
  const spawns: string[][] = []
  const exec: GitRemoteExec = async (args: string[]) => {
    spawns.push(args)
    if (args[0] === 'remote' && args.length === 1) {
      return { stdout: `${remotes.map((remote) => remote.name).join('\n')}\n` }
    }
    if (args[0] === 'remote' && args[1] === '-v') {
      return {
        stdout: remotes
          .flatMap((remote) => [
            `${remote.name}\t${remote.fetchUrl} (fetch)`,
            `${remote.name}\t${remote.pushUrl ?? remote.fetchUrl} (push)`
          ])
          .join('\n')
      }
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const match = remotes.find((remote) => remote.name === args[2])
      if (!match) {
        throw new Error(`No such remote ${args[2]}`)
      }
      return { stdout: `${match.fetchUrl}\n` }
    }
    throw new Error(`unexpected git command: ${args.join(' ')}`)
  }
  return Object.assign(exec, { spawns })
}

/** The pre-fix scan, kept as the oracle the batched form must reproduce exactly. */
async function findRemoteForUrlPerRemote(
  execGit: GitRemoteExec,
  repoPath: string,
  remoteUrl: string
): Promise<string | null> {
  const target = parseGitHubOwnerRepo(remoteUrl)
  try {
    const { stdout } = await execGit(['remote'], repoPath)
    for (const remote of stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)) {
      try {
        const { stdout: urlStdout } = await execGit(['remote', 'get-url', remote], repoPath)
        const candidateUrl = urlStdout.trim()
        const candidate = parseGitHubOwnerRepo(candidateUrl)
        if (
          target &&
          candidate &&
          target.owner.toLowerCase() === candidate.owner.toLowerCase() &&
          target.repo.toLowerCase() === candidate.repo.toLowerCase()
        ) {
          return remote
        }
        if (candidateUrl === remoteUrl) {
          return remote
        }
      } catch {
        // Ignore a remote that disappeared or has no fetch URL.
      }
    }
  } catch {
    return null
  }
  return null
}

const fiftyEightRemotes: RemoteRow[] = [
  { name: 'origin', fetchUrl: UPSTREAM },
  ...Array.from({ length: 56 }, (_, index) => ({
    name: `pr-user${index}-orca`,
    fetchUrl: `https://github.com/user${index}/orca.git`
  })),
  { name: 'pr-contributor-orca', fetchUrl: SSH_FORK }
]

const matrix: { name: string; remotes: RemoteRow[]; lookupUrl: string }[] = [
  { name: 'no remotes', remotes: [], lookupUrl: SSH_FORK },
  {
    name: 'one matching remote',
    remotes: [{ name: 'origin', fetchUrl: SSH_FORK }],
    lookupUrl: SSH_FORK
  },
  {
    name: 'one non-matching remote',
    remotes: [{ name: 'origin', fetchUrl: UPSTREAM }],
    lookupUrl: SSH_FORK
  },
  { name: '58 remotes, match last', remotes: fiftyEightRemotes, lookupUrl: SSH_FORK },
  {
    name: '58 remotes, no match',
    remotes: fiftyEightRemotes,
    lookupUrl: 'https://github.com/nobody/other.git'
  },
  {
    name: 'duplicate URLs on two remotes',
    remotes: [
      { name: 'origin', fetchUrl: UPSTREAM },
      { name: 'fork-a', fetchUrl: SSH_FORK },
      { name: 'fork-b', fetchUrl: SSH_FORK }
    ],
    lookupUrl: SSH_FORK
  },
  {
    name: 'fetch and push URLs differ',
    remotes: [{ name: 'split', fetchUrl: SSH_FORK, pushUrl: HTTPS_FORK }],
    lookupUrl: SSH_FORK
  },
  {
    name: 'SSH-form lookup against an HTTPS-form remote',
    remotes: [
      { name: 'origin', fetchUrl: UPSTREAM },
      { name: 'fork', fetchUrl: HTTPS_FORK }
    ],
    lookupUrl: SSH_FORK
  },
  {
    name: 'HTTPS-form lookup against an SSH-form remote',
    remotes: [
      { name: 'origin', fetchUrl: UPSTREAM },
      { name: 'fork', fetchUrl: SSH_FORK }
    ],
    lookupUrl: HTTPS_FORK
  },
  {
    name: 'non-GitHub provider matches only on the exact URL',
    remotes: [{ name: 'gitlab-fork', fetchUrl: GITLAB_FORK }],
    lookupUrl: GITLAB_FORK
  },
  {
    name: 'non-GitHub provider with a different host does not match',
    remotes: [{ name: 'gitlab-fork', fetchUrl: GITLAB_FORK }],
    lookupUrl: 'https://bitbucket.org/contributor/orca.git'
  }
]

describe('findRemoteForUrl', () => {
  it.each(matrix)('matches the per-remote scan for $name', async ({ remotes, lookupUrl }) => {
    const expected = await findRemoteForUrlPerRemote(makeExec(remotes), '/repo', lookupUrl)
    await expect(findRemoteForUrl(makeExec(remotes), '/repo', lookupUrl)).resolves.toBe(expected)
  })

  it('answers from one subprocess at 58 remotes instead of one per remote', async () => {
    const legacyExec = makeExec(fiftyEightRemotes)
    await findRemoteForUrlPerRemote(legacyExec, '/repo', 'https://github.com/nobody/other.git')
    expect(legacyExec.spawns).toHaveLength(fiftyEightRemotes.length + 1)

    const exec = makeExec(fiftyEightRemotes)
    await findRemoteForUrl(exec, '/repo', 'https://github.com/nobody/other.git')
    expect(exec.spawns).toEqual([['remote', '-v']])
  })

  it('returns null when the remote table cannot be read', async () => {
    const failing: GitRemoteExec = async () => {
      throw new Error('not a git repository')
    }
    await expect(findRemoteForUrl(failing, '/repo', SSH_FORK)).resolves.toBeNull()
  })
})
