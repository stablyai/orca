import { parseExecutionHostId } from '../../shared/execution-host'

/**
 * Whether another machine holds this row's files, so its path must not authorize local reads.
 *
 * Fails closed on a stamp the parser rejects — empty `ssh:`, a bad escape, an embedded `|` (refused
 * so an alias cannot be rebound), an unknown prefix. `getSshTargetIdForExecutionHost` answers null
 * for all of them, and in an allow-list "cannot place this owner" must not read as "this machine".
 * A `runtime:` stamp stays local: on a repo row it names the store's own runtime, never a peer.
 */
export function hasRemoteFilesystemOwner(scope: {
  connectionId?: string | null
  executionHostId?: string | null
}): boolean {
  // Keep legacy exclusions, including runtime rows whose connection belongs to that runtime.
  if (scope.connectionId) {
    return true
  }
  const stampedHostId = scope.executionHostId?.trim()
  if (!stampedHostId) {
    return false
  }
  const host = parseExecutionHostId(stampedHostId)
  return host === null || host.kind === 'ssh'
}
