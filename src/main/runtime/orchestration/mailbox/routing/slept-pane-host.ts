import type { Repo } from '../../../../../shared/repository/repo-types'
import {
  canonicalExecutionHostId,
  getRepoExecutionHostId,
  getRepoRoutingConnectionId,
  isRemoteExecutionHostId,
  isUnresolvedOwnerHostId,
  normalizeHostPart,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree/id'
import type { SleptMailRecord } from './mail-wake-obligation'

type RepoHost = Pick<Repo, 'connectionId' | 'executionHostId'>

const NO_REPOS: readonly RepoHost[] = []

/** Which host each slept pane's agent runs on, so one host's availability edge retries only its own. */
export class SleptPaneHost {
  constructor(
    private readonly index: {
      hostOf(paneKey: string): string | null
      readonly records: ReadonlyMap<string, SleptMailRecord>
    },
    private readonly repos: (repoId: string) => readonly RepoHost[] | undefined
  ) {}

  /** The pane's own partition or saved SSH connection names its owner; only a pane neither names
   *  falls back to its repo's registrations, and one with no registration counts as on every host
   *  so a host edge never strands its wake. */
  on(host: string): (paneKey: string) => boolean {
    // Saved ids may spell a host either way (`runtime:wsl:x` or `runtime:wsl%3Ax`).
    const canonical = canonicalExecutionHostId(host) ?? host
    const onHost = (saved: string | null) =>
      saved !== null && canonicalExecutionHostId(saved) === canonical
    const ssh = parseExecutionHostId(host)
    const sshTarget = ssh?.kind === 'ssh' ? ssh.targetId : undefined
    return (paneKey) => {
      const record = this.index.records.get(paneKey)
      if (!record) {
        return true
      }
      const partition = this.index.hostOf(paneKey)
      const savedTarget = normalizeHostPart(record.connectionId)
      const remotePartition =
        isRemoteExecutionHostId(partition) && !isUnresolvedOwnerHostId(partition)
      if (remotePartition && (onHost(partition) || (sshTarget && savedTarget === sshTarget))) {
        return true
      }
      const repos = this.repos(getRepoIdFromWorktreeId(record.worktreeId)) ?? NO_REPOS
      const repoOnHost = (repo: RepoHost) => onHost(getRepoExecutionHostId(repo))
      // A pane's saved nested SSH target must match the registration that admits it.
      const repoDialsSaved = (repo: RepoHost) =>
        !savedTarget || getRepoRoutingConnectionId(repo) === savedTarget
      // A record whose host was unresolved when saved lands in the local partition.
      if (remotePartition) {
        // A rotated runtime id keeps the old partition while the repo moves to the new runtime.
        const savedCanonical = canonicalExecutionHostId(partition)
        return (
          ssh?.kind === 'runtime' &&
          parseExecutionHostId(partition)?.kind === 'runtime' &&
          repos.some((repo) => repoOnHost(repo) && repoDialsSaved(repo)) &&
          !repos.some(
            (repo) => canonicalExecutionHostId(getRepoExecutionHostId(repo)) === savedCanonical
          )
        )
      }
      if (savedTarget) {
        // A runtime's pane names the nested SSH target it dials through that runtime's registration.
        return (
          onHost(toSshExecutionHostId(savedTarget)) ||
          (ssh?.kind === 'runtime' &&
            repos.some((repo) => repoDialsSaved(repo) && repoOnHost(repo)))
        )
      }
      if (onHost(partition)) {
        return true
      }
      // A twin repo registered on several hosts can't name one owner, so any of them counts.
      let known = false
      for (const repo of repos) {
        if (repoOnHost(repo)) {
          return true
        }
        known ||= !isUnresolvedOwnerHostId(getRepoExecutionHostId(repo))
      }
      return !known
    }
  }
}
