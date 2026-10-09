import type { Repo } from '../../shared/repo-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import {
  BACKLOG_CAPABILITY_TIMEOUT_MS,
  BACKLOG_RELAY_TIMEOUT_MS,
  BacklogReply,
  type BacklogOperation
} from '../../shared/backlog-types'
import { getActiveMultiplexer } from '../ssh/ssh-target-registry'
import { executeBacklogOperation } from './backlog-service'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'

/** Executes on the repo's local or capability-checked SSH host; never falls back to local files. */
export async function routeBacklogOperation(
  repo: Repo,
  operation: BacklogOperation
): Promise<BacklogReply> {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (host?.kind === 'local') {
    return executeBacklogOperation(repo.path, operation)
  }
  if (host?.kind !== 'ssh') {
    throw new Error('Backlog requests must be sent to the project execution runtime.')
  }
  const mux = getActiveMultiplexer(host.targetId)
  if (!mux) {
    throw new Error('Reconnect the SSH host to use Backlog.md. Tasks will not be read locally.')
  }
  const capability = await mux
    .request('backlog.capabilities', {}, { timeoutMs: BACKLOG_CAPABILITY_TIMEOUT_MS })
    .catch((error: unknown) => {
      if (isMethodNotFoundError(error)) {
        throw new Error('Update the Orca SSH relay to use Backlog.md.')
      }
      throw error
    })
  if (
    !capability ||
    typeof capability !== 'object' ||
    !('version' in capability) ||
    capability.version !== 1
  ) {
    throw new Error('Update the Orca SSH relay to use Backlog.md.')
  }
  return BacklogReply.parse(
    await mux.request(
      'backlog.execute',
      { repoPath: repo.path, operation },
      { timeoutMs: BACKLOG_RELAY_TIMEOUT_MS }
    )
  )
}
