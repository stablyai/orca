import type { OrchestrationDb } from '../db/orchestration-db'
import {
  formatOrcaSessionAddress,
  type OrcaSessionId
} from '../../../../shared/agent-session/identity/orca-session-address'

/** A chat's own mailbox and those of the Runs it coordinates. */
export function orcaSessionMailboxes(db: OrchestrationDb, orcaSessionId: OrcaSessionId): string[] {
  return [
    formatOrcaSessionAddress(orcaSessionId),
    ...db
      .runsBoundToCoordinator({ orcaSessionId, paneKey: null, terminalHandle: null })
      .map((run) => `run:${run.id}`)
  ]
}
