import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import type { DispatchContextRow } from '../orchestration-records'
import type { OrcaRuntimeService } from '../../../orca-runtime'

// A starting Dispatch names its terminal only in its start options until its authority attaches.
// A start stranded by a runtime restart is racing nothing, so only this runtime's starts claim.
const STARTING_ON_TERMINAL_SQL = `SELECT d.* FROM dispatch_contexts d
  JOIN worker_dispatches w ON w.dispatch_id = d.id
  WHERE d.status = 'pending' AND w.state = 'starting' AND w.runtime_epoch = ?
    AND json_extract(w.start_options, '$.terminal') = ?
  ORDER BY d.rowid LIMIT 1`

type ClaimRuntime = Pick<OrcaRuntimeService, 'getTerminalPaneKey' | 'getRuntimeId'>

type TerminalClaim = {
  dispatchId: string
  taskId: string
  /** `remote`: a worker another computer started here; `remote_starting`: one not yet attached. */
  holder: 'local' | 'remote' | 'remote_starting'
  followUpOf: string | null
}

// A paired-server attach records its reused terminal only once its authority records the pane.
// Held in memory like a local start's runtime-epoch claim: a restart strands the attach, which then races nothing.
const startingRemoteAttachments = new WeakMap<
  OrchestrationDb,
  Map<string, { dispatchId: string; taskId: string }>
>()

/** Refuse a worker-start, follow-up or paired-server attach onto a terminal another open Dispatch holds or is starting on.
 *  Every entry claims through here synchronously before its insert, so whichever comes second is refused before any wait. */
export function refuseClaimedWorkerTerminal(
  db: OrchestrationDb,
  handle: string | undefined,
  runtime: ClaimRuntime,
  /** A racing follow-up of the same settled Dispatch is left to `follow_up_claimed`, which steers the send into it. */
  followUpOf: string | undefined
): void {
  if (!handle) {
    return
  }
  const claim = findWorkerTerminalClaim(db, handle, runtime)
  if (claim && !(followUpOf && claim.followUpOf === followUpOf)) {
    throw terminalBusyError(db, handle, claim)
  }
}

/** Claim a paired-server attach's reused terminal; call the returned release once the attach returns. */
export function claimTerminalForRemoteAttach(
  db: OrchestrationDb,
  handle: string | undefined,
  runtime: ClaimRuntime,
  attachment: { dispatchId: string; taskId: string }
): () => void {
  refuseClaimedWorkerTerminal(db, handle, runtime, undefined)
  if (!handle) {
    return () => {}
  }
  let claims = startingRemoteAttachments.get(db)
  if (!claims) {
    claims = new Map()
    startingRemoteAttachments.set(db, claims)
  }
  claims.set(handle, attachment)
  return () => {
    if (claims.get(handle) === attachment) {
      claims.delete(handle)
    }
  }
}

function findWorkerTerminalClaim(
  db: OrchestrationDb,
  handle: string,
  runtime: ClaimRuntime
): TerminalClaim | undefined {
  const paneKey = runtime.getTerminalPaneKey(handle) ?? undefined
  const local =
    db.findActiveDispatchForAssignee(handle, paneKey) ??
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: selects whole dispatch_contexts rows.
    (db.db.prepare(STARTING_ON_TERMINAL_SQL).get(runtime.getRuntimeId(), handle) as
      | DispatchContextRow
      | undefined)
  if (local) {
    return {
      dispatchId: local.id,
      taskId: local.task_id,
      holder: 'local',
      followUpOf: local.follow_up_of_dispatch_id
    }
  }
  const attached = paneKey ? db.findActiveRemoteAttachmentForPane(paneKey) : undefined
  if (attached) {
    return {
      dispatchId: attached.dispatch_id,
      taskId: attached.task_id,
      // Until its brief is accepted it can be neither sent to nor stopped.
      holder: attached.state === 'starting' ? 'remote_starting' : 'remote',
      followUpOf: null
    }
  }
  const starting = startingRemoteAttachments.get(db)?.get(handle)
  return starting ? { ...starting, holder: 'remote_starting', followUpOf: null } : undefined
}

function terminalBusyError(
  db: OrchestrationDb,
  handle: string,
  claim: TerminalClaim
): OrchestrationError {
  const data = { effectsApplied: false, dispatchId: claim.dispatchId, taskId: claim.taskId }
  const busy = `Terminal ${handle} is busy: Dispatch ${claim.dispatchId}`
  if (claim.holder === 'remote_starting') {
    return new OrchestrationError(
      'terminal_busy',
      `${busy} (task ${claim.taskId}), started from another computer, is still starting on it. Wait for that start to finish (from that computer, \`orchestration worker-show --dispatch ${claim.dispatchId}\` shows it), or use another terminal. No effects were applied.`,
      data
    )
  }
  if (claim.holder === 'remote') {
    return new OrchestrationError(
      'terminal_busy',
      `${busy} (task ${claim.taskId}), started from another computer, is still open on it. From that computer, give it more work with \`orchestration send --to dispatch:${claim.dispatchId}\` or stop it with \`orchestration worker-stop --dispatch ${claim.dispatchId}\`; or use another terminal. No effects were applied.`,
      data
    )
  }
  const task = db.getTask(claim.taskId)
  const title = task?.task_title ?? task?.spec.split('\n')[0]?.slice(0, 80)
  const followUp = claim.followUpOf ? `, the follow-up of Dispatch ${claim.followUpOf}` : ''
  return new OrchestrationError(
    'terminal_busy',
    `${busy}${followUp} (task ${claim.taskId}${title ? ` "${title}"` : ''}) is still open on it. To answer it or give it more work, use your Orca CLI's \`orchestration send --to dispatch:${claim.dispatchId}\`; to replace it, run \`orchestration worker-stop --dispatch ${claim.dispatchId}\` and then start again. No effects were applied.`,
    data
  )
}
