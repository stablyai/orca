import { selectBareRecipientOwner, runMismatch } from './recipient-owner-selection'
import type { LegacyAdoptedMailboxOwner, OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { DispatchContextRow, DispatchStatus } from '../../../../orchestration/types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { resolveOrchestrationParty } from '../../../../orchestration/orchestration-party'
import { isEquivalentPaneKey } from '../../../../orchestration/db/pane-key-match'
import type { OrchestrationCoordinatorKey } from '../../../../orchestration/orchestration-caller-identity'
import { CURRENT_CONTRACT_VERSION } from '../../../../orchestration/db/contract-constants'
import { readAgentSessionRecordStore } from '../../../../orchestration/structured-session-lineage'
import {
  readSessionRecipient,
  refuseUndeliverableSessionRecipient,
  type SessionRecipientRefusal
} from './session-recipient'

const ACTIVE_DISPATCH_STATUSES: readonly DispatchStatus[] = ['pending', 'dispatched']

/** Reject settled Dispatch mailboxes: no active reader remains and check never reroutes their mail. Federation checks its own liveness. */
export function assertDispatchMailboxDeliverable(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string
): void {
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch || ACTIVE_DISPATCH_STATUSES.includes(dispatch.status)) {
    return
  }
  const recipientRun = currentDispatchAssigneeRun(runtime, db, dispatch)?.id ?? dispatch.run_id
  throw new OrchestrationError(
    'dispatch_inactive',
    `Dispatch ${dispatchId} is ${dispatch.status}; its worker will never read that mailbox. Send to run:${recipientRun} instead, or start a new Dispatch for follow-up work.`
  )
}

// A saved pane alone cannot identify its occupant after reuse.
export function currentDispatchAssigneeRun(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatch: DispatchContextRow
) {
  const key = dispatchAssigneeCoordinatorKey(
    dispatch,
    () => Boolean(db.getFederatedDispatch(dispatch.id)),
    (handle) => runtime.getLiveTerminalPaneKey(handle),
    (handle) => runtime.getTerminalProcessIncarnation(handle)
  )
  return !key
    ? undefined
    : key.orcaSessionId !== null
      ? db.getCurrentRunForCoordinator(key)
      : key.paneKey
        ? db.getCurrentRunForPane(key.paneKey)
        : undefined
}

export function dispatchAssigneeCoordinatorKey(
  dispatch: Pick<
    DispatchContextRow,
    | 'contract_version'
    | 'assignee_handle'
    | 'assignee_pane_key'
    | 'assignee_orca_session_id'
    | 'process_incarnation'
  >,
  federated: () => boolean,
  livePane: (handle: string) => string | null,
  process: (handle: string) => string | null
): OrchestrationCoordinatorKey | undefined {
  if (dispatch.contract_version !== CURRENT_CONTRACT_VERSION || federated()) {
    return undefined
  }
  if (dispatch.assignee_orca_session_id !== null) {
    return {
      terminalHandle: dispatch.assignee_handle,
      paneKey: null,
      orcaSessionId: dispatch.assignee_orca_session_id
    }
  }
  if (dispatch.assignee_handle === null) {
    return undefined
  }
  const paneKey = livePane(dispatch.assignee_handle)
  if (
    !paneKey ||
    (dispatch.assignee_pane_key && !isEquivalentPaneKey(dispatch.assignee_pane_key, paneKey)) ||
    (dispatch.process_incarnation !== null &&
      process(dispatch.assignee_handle) !== dispatch.process_incarnation)
  ) {
    return undefined
  }
  return { terminalHandle: dispatch.assignee_handle, paneKey, orcaSessionId: null }
}

// Nested coordinators receive new mail where their current Run check waits.
export function resolveRunBoundDispatchRecipient(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string,
  explicitRunId?: string
): { to: string; runId: string; warning: SendRecipientWarning } | undefined {
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch || !ACTIVE_DISPATCH_STATUSES.includes(dispatch.status)) {
    return undefined
  }
  const boundRun = currentDispatchAssigneeRun(runtime, db, dispatch)
  return selectRunBoundDispatchRecipient(dispatch, boundRun, explicitRunId)
}

export function selectRunBoundDispatchRecipient(
  dispatch: Pick<DispatchContextRow, 'id' | 'run_id'>,
  boundRun: { id: string } | undefined,
  explicitRunId?: string
): { to: string; runId: string; warning: SendRecipientWarning } | undefined {
  if (!boundRun || boundRun.id === dispatch.run_id) {
    return undefined
  }
  const recipient = `dispatch:${dispatch.id}`
  // Naming the Dispatch's own Run is equivalent to omitting --run.
  const mismatch =
    explicitRunId === dispatch.run_id
      ? undefined
      : runMismatch(recipient, boundRun.id, explicitRunId)
  if (mismatch && !mismatch.ok) {
    throw new OrchestrationError(mismatch.code, mismatch.message)
  }
  return {
    to: `run:${boundRun.id}`,
    runId: boundRun.id,
    warning: {
      code: 'recipient_run_bound_redirect',
      recipient,
      message: `${recipient} is assigned to a terminal that now coordinates Run ${boundRun.id}; queued for run:${boundRun.id}, the mailbox that terminal reads.`
    }
  }
}

// Replies share send routing; unresolved historical senders keep their original address.
export function resolveReplyRecipient(params: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  originalFrom: string
  originalRunId: string | undefined
}): { to: string; runId: string | undefined } {
  const { runtime, db, originalFrom, originalRunId } = params
  const unchanged = { to: originalFrom, runId: originalRunId }
  if (originalFrom.startsWith('run:')) {
    return { to: originalFrom, runId: originalFrom.slice('run:'.length) }
  }
  if (originalFrom.startsWith('dispatch:')) {
    const dispatchId = originalFrom.slice('dispatch:'.length)
    // Federation owns its own recipient and liveness checks.
    if (db.getFederatedDispatch(dispatchId)) {
      return unchanged
    }
    assertDispatchMailboxDeliverable(runtime, db, dispatchId)
    const runBound = resolveRunBoundDispatchRecipient(runtime, db, dispatchId)
    return runBound ?? unchanged
  }
  const recipient = resolveBareOrchestrationRecipient({
    runtime,
    db,
    handle: originalFrom,
    senderRunId: originalRunId
  })
  return recipient.ok ? { to: recipient.to, runId: recipient.runId ?? originalRunId } : unchanged
}

export type SendRecipientWarning = {
  code:
    | 'legacy_terminal_recipient'
    | 'recipient_run_bound_redirect'
    | 'recipient_unreachable'
    | 'recipient_ambiguous'
    | 'recipient_run_mismatch'
  recipient: string
  message: string
}

export type BareRecipientResolution =
  | {
      ok: true
      to: string
      runId: string | undefined
      warning?: SendRecipientWarning
    }
  | {
      ok: false
      code:
        | 'terminal_not_found'
        | 'recipient_ambiguous'
        | 'recipient_run_mismatch'
        | SessionRecipientRefusal['code']
      message: string
      warning: SendRecipientWarning
    }

export function resolveBareOrchestrationRecipient(params: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  handle: string
  senderRunId?: string
  explicitRunId?: string
  legacyAdoptedMailboxOwner?: LegacyAdoptedMailboxOwner | null
}): BareRecipientResolution {
  const { runtime, db } = params
  const sessionStore = readAgentSessionRecordStore()
  const session = readSessionRecipient(params.handle, sessionStore)
  if (session && 'code' in session) {
    return refused(params.handle, session)
  }
  const party = resolveOrchestrationParty(session?.address ?? params.handle, db)
  const handle = party.address
  const paneKey =
    party.terminalHandle === null
      ? undefined
      : (runtime.getLiveTerminalPaneKey(party.terminalHandle) ?? undefined)
  return selectBareRecipientOwner({
    ...params,
    handle,
    boundRuns: () =>
      party.orcaSessionId !== null
        ? db.runsBoundToCoordinator(party)
        : paneKey
          ? db.runsBoundToPane(paneKey)
          : [],
    dispatches: () => db.getActiveDispatchMailboxOwners(handle, paneKey),
    ownerRunIds: () => db.getRunMailboxOwnerIdsForHandle(handle, params.legacyAdoptedMailboxOwner),
    fallback: () => {
      if (session) {
        const refusal = refuseUndeliverableSessionRecipient(session, sessionStore, db)
        return refusal
          ? refused(params.handle, refusal)
          : { ok: true, to: handle, runId: params.senderRunId }
      }

      if (paneKey) {
        return {
          ok: true,
          to: handle,
          runId: params.senderRunId,
          warning: {
            code: 'legacy_terminal_recipient',
            recipient: handle,
            message: `${handle} is a live terminal-only mailbox. Delivery is not durable after that terminal closes; prefer run:<id> or dispatch:<id>.`
          }
        }
      }

      const message = `Terminal ${handle} has no live pane or durable Run/Dispatch mailbox.`
      return {
        ok: false,
        code: 'terminal_not_found',
        message,
        warning: { code: 'recipient_unreachable', recipient: handle, message }
      }
    }
  })
}

function refused(recipient: string, refusal: SessionRecipientRefusal): BareRecipientResolution {
  return {
    ok: false,
    code: refusal.code,
    message: refusal.message,
    warning: { code: 'recipient_unreachable', recipient, message: refusal.message }
  }
}

export { selectBareRecipientOwner } from './recipient-owner-selection'
