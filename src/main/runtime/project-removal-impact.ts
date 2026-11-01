import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../shared/execution-host'
import { splitWorktreeId } from '../../shared/worktree/id'
import { worktreePtyBelongsToHost, type WorktreePtyHostFence } from './worktree-pty-host-fence'

export type ProjectRemovalImpact = {
  liveTerminals: number
  workspacesWithMetadata: number
}

type RepoIdentity = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>

function repoPtyHostFence(repo: RepoIdentity): WorktreePtyHostFence {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return host?.kind === 'runtime'
    ? { resolvedRuntimeEnvironmentId: host.environmentId }
    : { resolvedConnectionId: host?.kind === 'ssh' ? host.targetId : null }
}

/** Terminals not known to have exited count: a lost-contact PTY may still be running. */
export function countRepoTerminalsNotKnownExited(
  repo: RepoIdentity,
  ptys: Iterable<{ ptyId: string; worktreeId: string; connectionId: string | null }>,
  isKnownExited: (ptyId: string) => boolean
): number {
  const fence = repoPtyHostFence(repo)
  let count = 0
  for (const pty of ptys) {
    if (
      splitWorktreeId(pty.worktreeId)?.repoId === repo.id &&
      worktreePtyBelongsToHost(pty.ptyId, pty.connectionId, fence) &&
      !isKnownExited(pty.ptyId)
    ) {
      count += 1
    }
  }
  return count
}

/** Same host rule as the repo prune: unstamped metadata predates host stamping and is local. */
export function countRepoWorkspacesWithMetadata(
  repo: RepoIdentity,
  metaById: Record<string, Pick<WorktreeMeta, 'hostId'>>
): number {
  const hostId = getRepoExecutionHostId(repo)
  const prefix = `${repo.id}::`
  return Object.entries(metaById).filter(
    ([id, meta]) => id.startsWith(prefix) && (meta.hostId ?? LOCAL_EXECUTION_HOST_ID) === hostId
  ).length
}

export function describeProjectRemovalRefusal(impact: ProjectRemovalImpact): string | null {
  const parts: string[] = []
  if (impact.liveTerminals > 0) {
    parts.push(
      `${impact.liveTerminals} terminal${impact.liveTerminals === 1 ? '' : 's'} still open`
    )
  }
  if (impact.workspacesWithMetadata > 0) {
    parts.push(
      `saved details for ${impact.workspacesWithMetadata} workspace${impact.workspacesWithMetadata === 1 ? '' : 's'}`
    )
  }
  if (parts.length === 0) {
    return null
  }
  return `This project has ${parts.join(' and ')}. Removing it detaches those terminals from Orca and deletes the saved workspace details. Re-run with --force to remove it anyway.`
}
