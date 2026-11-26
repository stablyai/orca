import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { RemoteRunLinkRow } from '../../db/remote-owned/remote-run-links'

/** The Run's newest link to the server: open, closed by a re-pair, or owing a reset's cancel. */
export function latestRunLink(
  db: OrchestrationDb,
  runId: string,
  environmentId: string
): RemoteRunLinkRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table returns exactly its row shape.
  return db.db
    .prepare(
      'SELECT * FROM remote_run_links WHERE run_id = ? AND environment_id = ? ORDER BY rowid DESC'
    )
    .get(runId, environmentId) as RemoteRunLinkRow | undefined
}

/** A re-pair is not recovered: the Run's earlier workers there are shown only from this Orca's record. */
export function repairedListError(serverName: string): OrchestrationError {
  return new OrchestrationError(
    'server_pairing_changed',
    `${serverName} was re-paired; workers started before that are no longer listed here. worker-show still shows them from this computer's record.`,
    { server: serverName }
  )
}
