import { parseExecutionHostId } from '../../shared/execution-host'

/** Local reads require a placeable local owner; malformed stamps fail closed. Repo runtime: stamps identify this store, not peers. */
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
