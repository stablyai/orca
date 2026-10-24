import type { OrcadTerminalCensus } from '../../../shared/orcad-terminal-census'
import type { OrcadRollbackResult } from '../install/orcad-remote-rollback'

export function rollbackRecountRefusal(census: OrcadTerminalCensus): OrcadRollbackResult | null {
  const live = census.liveSessions
  if (live === 0) {
    return null
  }
  return {
    outcome: 'refused',
    code: live === null ? 'orcad_rollback_census_unavailable' : 'orcad_rollback_terminals_running',
    reason:
      live === null
        ? 'The server did not answer how many terminals it runs. Retry when it answers.'
        : 'A terminal opened on this server before it could be stopped; close it, then retry.'
  }
}

export const ROLLBACK_STALE_COUNT: OrcadRollbackResult = {
  outcome: 'refused',
  code: 'orcad_rollback_census_unavailable',
  reason: 'The terminal count went stale before the server could be stopped. Retry the rollback.'
}
