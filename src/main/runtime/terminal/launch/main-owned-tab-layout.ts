// Main starts only tabs its layout owns; paired-server tabs keep the window path.
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

/** The tab's first holding partition is one main owns, not a paired server's. */
export function mainOwnsTabLayout(hostIds: readonly ExecutionHostId[]): boolean {
  const [hostId] = hostIds
  return Boolean(hostId && parseExecutionHostId(hostId)?.kind !== 'runtime')
}
