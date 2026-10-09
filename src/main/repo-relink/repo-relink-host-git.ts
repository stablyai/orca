import type { ExecutionHostId } from '../../shared/execution-host'
import { GitCommandTimeoutError } from '../../shared/git-command-timeout'
import {
  normalizeGitRemoteUrl,
  parseGitRemoteVerboseOutput
} from '../../shared/git-remote-identity'
import type { Repo } from '../../shared/repo-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { normalizeGitRepoRootForInputPath } from '../git/repo'
import { runGitProbeOnHost } from '../repo-git-remote-identity'
import { listRepoWorktreesForDetectedScan } from '../repo-worktrees'
import { isSshRequestOutcomeUnverifiable } from '../ssh/ssh-channel-multiplexer'

export type HostToplevelProbe =
  | { kind: 'toplevel'; path: string }
  | { kind: 'not-repo' }
  | { kind: 'unverifiable' }

export type HostRemoteKeysProbe = { kind: 'resolved'; keys: string[] } | { kind: 'unverifiable' }

/** Read-only git questions the relink asks the host that owns the repository. */
export type RepoRelinkHostGit = {
  showToplevel: (path: string) => Promise<HostToplevelProbe>
  /** Null when the listing could not be read; identity evidence then degrades, never passes. */
  listWorktrees: (path: string) => Promise<GitWorktreeInfo[] | null>
  readRemoteKeys: (path: string) => Promise<HostRemoteKeysProbe>
}

export function createRepoRelinkHostGit(repo: Repo, hostId: ExecutionHostId): RepoRelinkHostGit {
  return {
    showToplevel: async (path) => {
      try {
        // `rev-parse --show-toplevel` predates the Git 2.25 baseline and passes the relay allowlist.
        const result = await runGitProbeOnHost(['rev-parse', '--show-toplevel'], path, hostId)
        if (!result) {
          return { kind: 'unverifiable' }
        }
        const toplevel = result.stdout.replace(/\r?\n$/, '')
        return toplevel
          ? { kind: 'toplevel', path: normalizeGitRepoRootForInputPath(path, toplevel) }
          : { kind: 'not-repo' }
      } catch (error) {
        return isSshRequestOutcomeUnverifiable(error) || error instanceof GitCommandTimeoutError
          ? { kind: 'unverifiable' }
          : { kind: 'not-repo' }
      }
    },
    listWorktrees: async (path) => {
      try {
        return await listRepoWorktreesForDetectedScan({ ...repo, path })
      } catch {
        return null
      }
    },
    readRemoteKeys: async (path) => {
      try {
        const result = await runGitProbeOnHost(['remote', '-v'], path, hostId)
        if (!result) {
          return { kind: 'unverifiable' }
        }
        const keys = parseGitRemoteVerboseOutput(result.stdout)
          .map((entry) => normalizeGitRemoteUrl(entry.url))
          .filter((key): key is string => Boolean(key))
        return { kind: 'resolved', keys: [...new Set(keys)] }
      } catch {
        return { kind: 'unverifiable' }
      }
    }
  }
}
