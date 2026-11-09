import type { Repo } from '../../shared/repo-types'
import { getSshTargetIdForExecutionHost, normalizeHostPart } from '../../shared/execution-host'
import type { BacklogOperation, BacklogReply } from '../../shared/backlog-types'
import { getStoredRepoExecutionHostId } from '../workspaces/execution-host/repo-execution-host'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { executeBacklogOperation } from './backlog-service'

const BACKLOG_SSH_NOT_SERVED_MESSAGE =
  'Reconnect the SSH host to use Backlog.md. Tasks will not be read locally.'

/** Runs on the runtime whose Store registered the repo; SSH projects are served by their host's runtime, never by local files. */
export function routeBacklogOperation(
  repo: Repo,
  operation: BacklogOperation
): Promise<BacklogReply> {
  const sshTargetId =
    getSshTargetIdForExecutionHost(getStoredRepoExecutionHostId(repo)) ??
    normalizeHostPart(repo.connectionId)
  if (sshTargetId) {
    throw new SshHostNotServedError(sshTargetId, BACKLOG_SSH_NOT_SERVED_MESSAGE)
  }
  return executeBacklogOperation(repo.path, operation)
}
