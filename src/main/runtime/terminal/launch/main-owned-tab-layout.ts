// Main starts only tabs its layout owns; paired-server tabs keep the window path.
import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { WorkspaceSessionPartitionId } from '../../../../shared/workspace-session/teammate-homes-session-partition'

/** The tab's first holding partition is one main owns, not a paired server's. */
export function mainOwnsTabLayout(hostIds: readonly WorkspaceSessionPartitionId[]): boolean {
  const [hostId] = hostIds
  return Boolean(hostId && parseExecutionHostId(hostId)?.kind !== 'runtime')
}
