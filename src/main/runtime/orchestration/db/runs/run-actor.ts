import type { DispatchContextRow, RemoteDispatchAttachmentRow } from '../../types'
import type { OrchestrationCoordinatorKey } from '../../orchestration-caller-identity'
import { canonicalOrcaSessionId } from '../../canonical-orca-session-id'
import { OrchestrationError } from '../../orchestration-error'
import { isSelfCreatedDispatch } from '../dispatch-depth'
import { potentiallyLiveRemoteAttachmentSql } from '../federation/remote-attachment-liveness'
import type { OrchestrationDb } from '../orchestration-db'
import {
  isEquivalentPaneKey,
  paneKeyMatchSuffix,
  DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL
} from '../pane-key-match'

export type RunCallerKey = OrchestrationCoordinatorKey & { processIncarnation: string | null }
export type RunActor =
  | { kind: 'root' }
  | { kind: 'local'; dispatch: DispatchContextRow }
  | { kind: 'remote'; attachment: RemoteDispatchAttachmentRow }

export function refuseRunAuthority(message: string): never {
  throw new OrchestrationError('run_ownership_required', `${message} No effects were applied.`, {
    effectsApplied: false
  })
}

export function sameExactCaller(a: RunCallerKey, b: RunCallerKey): boolean {
  if (a.orcaSessionId && b.orcaSessionId) {
    return canonicalOrcaSessionId(a.orcaSessionId) === canonicalOrcaSessionId(b.orcaSessionId)
  }
  return Boolean(
    a.paneKey &&
    b.paneKey &&
    isEquivalentPaneKey(a.paneKey, b.paneKey) &&
    a.processIncarnation &&
    a.processIncarnation === b.processIncarnation
  )
}

export function requireExactCaller(key: RunCallerKey): void {
  if (!key.orcaSessionId && !(key.paneKey && key.processIncarnation)) {
    refuseRunAuthority(
      'Orca cannot verify this caller’s exact agent process. Run the command from a live Orca agent.'
    )
  }
}

// Collect every address/pane/session candidate: conflicting roles must never disappear behind LIMIT 1.
export function resolveRunActor(db: OrchestrationDb, caller: RunCallerKey): RunActor {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Complete schema projection of dispatch_contexts.
  const candidates = db.db
    .prepare(`SELECT * FROM dispatch_contexts
    WHERE status IN ('pending', 'dispatched') AND
      (assignee_handle = ? OR assignee_orca_session_id = ? OR
       (assignee_pane_key IS NOT NULL AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ?))`)
    .all(
      caller.terminalHandle,
      caller.orcaSessionId,
      caller.paneKey ? paneKeyMatchSuffix(caller.paneKey) : null
    ) as DispatchContextRow[]
  const local = candidates
    .filter(
      (row) =>
        (row.assignee_handle !== null && row.assignee_handle === caller.terminalHandle) ||
        (row.assignee_orca_session_id !== null &&
          caller.orcaSessionId !== null &&
          canonicalOrcaSessionId(row.assignee_orca_session_id) ===
            canonicalOrcaSessionId(caller.orcaSessionId)) ||
        (row.assignee_pane_key !== null &&
          caller.paneKey !== null &&
          isEquivalentPaneKey(row.assignee_pane_key, caller.paneKey))
    )
    .filter((row) => !isSelfCreatedDispatch(row))
  const attachments = caller.paneKey
    ? db.db
        .prepare(`SELECT * FROM remote_dispatch_attachments
    WHERE ${potentiallyLiveRemoteAttachmentSql()} AND pane_key IS NOT NULL
      AND substr(pane_key, instr(pane_key, ':') + 1) = ?`)
        .all(paneKeyMatchSuffix(caller.paneKey))
    : []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Complete schema projection of remote_dispatch_attachments.
  const remote = (attachments as RemoteDispatchAttachmentRow[]).filter(
    (row) => row.pane_key && caller.paneKey && isEquivalentPaneKey(row.pane_key, caller.paneKey)
  )
  if (local.length + remote.length > 1) {
    refuseRunAuthority(
      'This caller matches several active worker assignments; Orca cannot establish ownership.'
    )
  }
  const dispatch = local[0]
  if (dispatch) {
    const sessionMatch =
      dispatch.assignee_orca_session_id &&
      caller.orcaSessionId &&
      canonicalOrcaSessionId(dispatch.assignee_orca_session_id) ===
        canonicalOrcaSessionId(caller.orcaSessionId)
    if (
      !sessionMatch &&
      dispatch.assignee_pane_key &&
      (!caller.paneKey || !isEquivalentPaneKey(dispatch.assignee_pane_key, caller.paneKey))
    ) {
      refuseRunAuthority('This worker’s recorded pane no longer matches the caller.')
    }
    if (
      dispatch.process_incarnation &&
      dispatch.process_incarnation !== caller.processIncarnation
    ) {
      refuseRunAuthority('This worker’s recorded agent process no longer matches the caller.')
    }
    if (
      dispatch.assignee_orca_session_id &&
      caller.orcaSessionId &&
      canonicalOrcaSessionId(dispatch.assignee_orca_session_id) !==
        canonicalOrcaSessionId(caller.orcaSessionId)
    ) {
      refuseRunAuthority('This worker’s recorded session no longer matches the caller.')
    }
    if (db.getDispatchContext(dispatch.task_id)?.id !== dispatch.id) {
      refuseRunAuthority('This worker has been replaced by a newer attempt of its Task.')
    }
    return { kind: 'local', dispatch }
  }
  const attachment = remote[0]
  if (attachment) {
    if (
      !caller.processIncarnation ||
      attachment.process_incarnation !== caller.processIncarnation
    ) {
      refuseRunAuthority('This remote worker’s exact agent process cannot be verified.')
    }
    return { kind: 'remote', attachment }
  }
  return { kind: 'root' }
}
