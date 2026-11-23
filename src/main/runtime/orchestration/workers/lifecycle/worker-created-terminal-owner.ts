import type { OrchestrationDb } from '../../db/orchestration-db'
import type { WorkerTerminalResourceRow } from '../../terminal-authority/release/worker-terminal-ownership'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationCompatibilityEvidence } from '../../../../../shared/orchestration/orchestration-compatibility-evidence'
import type { RpcCallerIdentity } from '../../../rpc/callers/rpc-caller-identity'
import {
  isEquivalentPaneKey,
  paneKeyMatchSuffix,
  WORKER_TERMINAL_PANE_KEY_MATCH_SUFFIX_SQL
} from '../../db/pane-key-match'
import { bindWorkerTerminal } from '../../db/worker-terminal/worker-bound-terminals'
import { resolveStructuredWorkerIdentityForSession } from '../../terminal-authority/structured-sessions/structured-worker-authority'

/** `orca terminal create` run by a worker's own agent binds the new terminal to that worker, so it closes
 *  with it. People's windows and phones send no caller, and any other agent's terminal or chat names no
 *  worker, so their terminals get no owner; nor does one created with --keep-open. */
export function bindTerminalToCallingWorker(
  runtime: Pick<
    OrcaRuntimeService,
    'getExistingOrchestrationDb' | 'getTerminalPaneKey' | 'getTerminalHandleForPaneKey'
  >,
  caller: {
    caller?: RpcCallerIdentity
    orchestrationCompatibilityEvidence?: OrchestrationCompatibilityEvidence
  },
  terminalHandle: string,
  keepOpen: boolean
): void {
  const evidence = caller.orchestrationCompatibilityEvidence
  const db =
    !keepOpen && caller.caller?.kind === 'local-cli' && evidence
      ? runtime.getExistingOrchestrationDb()
      : null
  if (!db || !evidence) {
    return
  }
  const workerHandle = evidence.agentSessionId
    ? resolveStructuredWorkerIdentityForSession(evidence.agentSessionId, db)?.handle
    : evidence.terminalHandle
  // A shell that outlived an Orca restart keeps its old handle; its pane still names the worker.
  const resource =
    (workerHandle ? db.getWorkerTerminalResourceByHandle(workerHandle) : undefined) ??
    (evidence.agentSessionId || !evidence.paneKey
      ? undefined
      : workerResourceForPane(db, evidence.paneKey))
  if (
    resource?.ownership_state !== 'owned' ||
    resource.release_state === 'released' ||
    !resource.pane_key
  ) {
    return
  }
  // The worker's pane must be live: a stale handle must not bind to whatever now has its pane.
  const callerPane =
    (workerHandle ? runtime.getTerminalPaneKey(workerHandle) : null) ??
    (runtime.getTerminalHandleForPaneKey(resource.pane_key) ? resource.pane_key : null)
  const paneKey = runtime.getTerminalPaneKey(terminalHandle)
  if (!paneKey || !callerPane || !isEquivalentPaneKey(callerPane, resource.pane_key)) {
    return
  }
  bindWorkerTerminal(db, {
    dispatchId: resource.origin_dispatch_id,
    terminalHandle,
    paneKey,
    role: 'created'
  })
}

function workerResourceForPane(
  db: OrchestrationDb,
  paneKey: string
): WorkerTerminalResourceRow | undefined {
  // A reminted tab id still names the same leaf, as worker resources match elsewhere.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * of the table the row type mirrors.
  const candidates = db.db
    .prepare(
      `SELECT * FROM worker_terminal_resources
        WHERE pane_key = ? OR ${WORKER_TERMINAL_PANE_KEY_MATCH_SUFFIX_SQL} = ?
        ORDER BY updated_at DESC`
    )
    .all(paneKey, paneKeyMatchSuffix(paneKey)) as WorkerTerminalResourceRow[]
  return candidates.find(
    (row) => row.pane_key !== null && isEquivalentPaneKey(row.pane_key, paneKey)
  )
}
