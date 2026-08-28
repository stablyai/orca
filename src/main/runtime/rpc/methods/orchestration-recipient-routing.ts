import type { LegacyAdoptedMailboxOwner, OrchestrationDb } from '../../orchestration/db'
import type { DispatchContextRow } from '../../orchestration/types'
import type { OrcaRuntimeService } from '../../orca-runtime'

export type SendRecipientWarning = {
  code:
    | 'legacy_terminal_recipient'
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
      code: 'terminal_not_found' | 'recipient_ambiguous' | 'recipient_run_mismatch'
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
  const { runtime, db, handle } = params
  const paneKey = runtime.getLiveTerminalPaneKey(handle) ?? undefined
  const boundRun = paneKey ? db.getCurrentRunForPane(paneKey) : undefined
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
