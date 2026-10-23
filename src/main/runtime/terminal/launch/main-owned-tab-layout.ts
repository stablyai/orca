// Layout-owner build: main writes and starts a tab's panes only when main's layout holds the tab;
// a paired server's tab (a runtime host) keeps the window's path.
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

/** The tab's first holding partition is one main owns, not a paired server's. */
export function mainOwnsTabLayout(hostIds: readonly ExecutionHostId[]): boolean {
  const [hostId] = hostIds
  return Boolean(hostId && parseExecutionHostId(hostId)?.kind !== 'runtime')
}
