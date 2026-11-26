import type { Repo } from '../../../../../shared/repository/repo-types'
import {
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
    const ssh = parseExecutionHostId(host)
    const sshTarget = ssh?.kind === 'ssh' ? ssh.targetId : undefined
    return (paneKey) => {
      const record = this.index.records.get(paneKey)
      if (!record || this.index.hostOf(paneKey) === host) {
        return true
      }
      if (sshTarget !== undefined && record.connectionId === sshTarget) {
        return true
      }
      const repo = this.repo(getRepoIdFromWorktreeId(record.worktreeId))
      return !repo || getRepoExecutionHostIdOrDefault(repo, LOCAL_EXECUTION_HOST_ID) === host
    }
  }
}
