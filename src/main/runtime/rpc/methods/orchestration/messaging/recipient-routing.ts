import type { LegacyAdoptedMailboxOwner, OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { DispatchContextRow, DispatchStatus } from '../../../../orchestration/types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { resolveOrchestrationParty } from '../../../../orchestration/orchestration-party'
import { isEquivalentPaneKey } from '../../../../orchestration/db/pane-key-match'
import { CURRENT_CONTRACT_VERSION } from '../../../../orchestration/db/contract-constants'
import { readAgentSessionRecordStore } from '../../../../orchestration/structured-session-lineage'
import {
  readSessionRecipient,
  refuseUndeliverableSessionRecipient,
  type SessionRecipientRefusal
} from './session-recipient'

const ACTIVE_DISPATCH_STATUSES: readonly DispatchStatus[] = ['pending', 'dispatched']

/**
 * Reject mail addressed to a Dispatch mailbox nobody will ever read again.
 *
 * Why: a settled Dispatch has no active reader and `check` never reroutes its
 * mailbox, so accepting the message reports success for a delivery that cannot
 * happen. Federated targets keep their own liveness check.
 */
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
  if (
    dispatch.contract_version !== CURRENT_CONTRACT_VERSION ||
    db.getFederatedDispatch(dispatch.id)
  ) {
    return undefined
  }
  if (dispatch.assignee_orca_session_id !== null) {
    return db.getCurrentRunForCoordinator({
      terminalHandle: dispatch.assignee_handle,
      paneKey: null,
      orcaSessionId: dispatch.assignee_orca_session_id
    })
  }
  if (dispatch.assignee_handle === null) {
    return undefined
  }
  const paneKey = runtime.getLiveTerminalPaneKey(dispatch.assignee_handle)
  if (
    !paneKey ||
    (dispatch.assignee_pane_key && !isEquivalentPaneKey(dispatch.assignee_pane_key, paneKey)) ||
    (dispatch.process_incarnation !== null &&
      runtime.getTerminalProcessIncarnation(dispatch.assignee_handle) !==
        dispatch.process_incarnation)
  ) {
    return undefined
  }
  return db.getCurrentRunForPane(paneKey)
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
  if (!boundRun || boundRun.id === dispatch.run_id) {
    return undefined
  }
  const recipient = `dispatch:${dispatchId}`
  const mismatch = runMismatch(recipient, boundRun.id, explicitRunId)
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
    | 'delivery_not_relayed'
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
  // Why: a session-backed party's Run binding is durable, so it outranks whether its pane is live.
  const boundRun =
    party.orcaSessionId !== null
      ? db.getCurrentRunForCoordinator(party)
      : paneKey
        ? db.getCurrentRunForPane(paneKey)
        : undefined
  if (boundRun) {
    const mismatch = runMismatch(handle, boundRun.id, params.explicitRunId)
    return mismatch ?? { ok: true, to: `run:${boundRun.id}`, runId: boundRun.id }
  }

  const dispatches = db.getActiveDispatchMailboxOwners(handle, paneKey)
  const dispatch = selectDispatch(dispatches, params.explicitRunId)
  if (dispatches.length > 0 && !dispatch) {
    return ambiguous(
      handle,
      dispatches.map((candidate) => `dispatch:${candidate.id}`)
    )
  }
  if (dispatch) {
    const mismatch = runMismatch(handle, dispatch.run_id, params.explicitRunId)
    return mismatch ?? { ok: true, to: `dispatch:${dispatch.id}`, runId: dispatch.run_id }
  }

  const ownerRunIds = db.getRunMailboxOwnerIdsForHandle(handle, params.legacyAdoptedMailboxOwner)
  const selectedRunId = selectHistoricalRun(ownerRunIds, params)
  if (ownerRunIds.length > 0 && !selectedRunId) {
    return ambiguous(
      handle,
      ownerRunIds.map((runId) => `run:${runId}`)
    )
  }
  if (selectedRunId) {
    const mismatch = runMismatch(handle, selectedRunId, params.explicitRunId)
    return mismatch ?? { ok: true, to: `run:${selectedRunId}`, runId: selectedRunId }
  }

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

function refused(recipient: string, refusal: SessionRecipientRefusal): BareRecipientResolution {
  return {
    ok: false,
    code: refusal.code,
    message: refusal.message,
    warning: { code: 'recipient_unreachable', recipient, message: refusal.message }
  }
}

function selectDispatch(
  dispatches: DispatchContextRow[],
  explicitRunId: string | undefined
): DispatchContextRow | undefined {
  if (dispatches.length === 1) {
    return dispatches[0]
  }
  if (!explicitRunId) {
    return undefined
  }
  const matches = dispatches.filter((dispatch) => dispatch.run_id === explicitRunId)
  return matches.length === 1 ? matches[0] : undefined
}

function selectHistoricalRun(
  ownerRunIds: string[],
  params: { senderRunId?: string; explicitRunId?: string }
): string | undefined {
  if (params.explicitRunId && ownerRunIds.includes(params.explicitRunId)) {
    return params.explicitRunId
  }
  if (params.senderRunId && ownerRunIds.includes(params.senderRunId)) {
    return params.senderRunId
  }
  return ownerRunIds.length === 1 ? ownerRunIds[0] : undefined
}

function ambiguous(handle: string, addresses: string[]): BareRecipientResolution {
  const message = `${handle} resolves to multiple durable mailboxes (${addresses.join(', ')}). Use an explicit canonical address.`
  return {
    ok: false,
    code: 'recipient_ambiguous',
    message,
    warning: { code: 'recipient_ambiguous', recipient: handle, message }
  }
}

function runMismatch(
  handle: string,
  resolvedRunId: string,
  explicitRunId: string | undefined
): BareRecipientResolution | undefined {
  if (!explicitRunId || explicitRunId === resolvedRunId) {
    return undefined
  }
  const message = `${handle} belongs to Run ${resolvedRunId}, not explicitly requested Run ${explicitRunId}.`
  return {
    ok: false,
    code: 'recipient_run_mismatch',
    message,
    warning: { code: 'recipient_run_mismatch', recipient: handle, message }
  }
}
