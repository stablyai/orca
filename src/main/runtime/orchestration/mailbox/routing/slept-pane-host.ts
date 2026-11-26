import type { Repo } from '../../../../../shared/repository/repo-types'
import {
  canonicalExecutionHostId,
  getRepoExecutionHostIdOrDefault,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree/id'
import type { SleptMailRecord } from './mail-wake-obligation'

type RepoHost = Pick<Repo, 'connectionId' | 'executionHostId'>

/** Which host each slept pane's agent runs on, so one host's availability edge retries only its own. */
export class SleptPaneHost {
  constructor(
    private readonly index: {
      hostOf(paneKey: string): string | null
      readonly records: ReadonlyMap<string, SleptMailRecord>
    },
    private readonly repo: (repoId: string) => RepoHost | undefined
  ) {}

  /** A pane whose host is unknown counts as on it, so a host edge never strands its wake. */
  on(host: string): (paneKey: string) => boolean {
    // Saved ids may spell a host either way (`runtime:wsl:x` or `runtime:wsl%3Ax`).
    const canonical = canonicalExecutionHostId(host) ?? host
    const onHost = (saved: string | null) =>
      saved !== null && canonicalExecutionHostId(saved) === canonical
    const ssh = parseExecutionHostId(host)
    const sshTarget = ssh?.kind === 'ssh' ? ssh.targetId : undefined
    return (paneKey) => {
      const record = this.index.records.get(paneKey)
      if (!record || onHost(this.index.hostOf(paneKey))) {
        return true
      }
      if (sshTarget !== undefined && record.connectionId === sshTarget) {
        return true
      }
      const repo = this.repo(getRepoIdFromWorktreeId(record.worktreeId))
      return !repo || onHost(getRepoExecutionHostIdOrDefault(repo, LOCAL_EXECUTION_HOST_ID))
    }
  }
}
