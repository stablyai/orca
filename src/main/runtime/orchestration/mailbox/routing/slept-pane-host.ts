import {
  canonicalExecutionHostId,
  isRemoteExecutionHostId,
  isUnresolvedOwnerHostId,
  parseExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree/id'
import type { SleptMailRecord } from './mail-wake-obligation'

/** Which host each slept pane's agent runs on, so one host's availability edge retries only its own. */
export class SleptPaneHost {
  constructor(
    private readonly index: {
      hostOf(paneKey: string): string | null
      readonly records: ReadonlyMap<string, SleptMailRecord>
    },
    private readonly repoHosts: (repoId: string) => ReadonlySet<string> | undefined
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
      if (onHost(partition)) {
        return true
      }
      if (sshTarget !== undefined && record.connectionId === sshTarget) {
        return true
      }
      // Only the local partition holds other hosts' panes (older builds saved SSH panes there).
      if (isRemoteExecutionHostId(partition) && !isUnresolvedOwnerHostId(partition)) {
        return false
      }
      if (sshTarget !== undefined && record.connectionId) {
        return false
      }
      // A twin repo registered on several hosts can't name one owner, so any of them counts.
      const hosts = this.repoHosts(getRepoIdFromWorktreeId(record.worktreeId))
      if (!hosts?.size) {
        return true
      }
      for (const saved of hosts) {
        if (onHost(saved)) {
          return true
        }
      }
      return false
    }
  }
}
