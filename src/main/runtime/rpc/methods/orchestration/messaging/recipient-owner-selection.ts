import type { DispatchContextRow } from '../../../../orchestration/types'
import type { BareRecipientResolution } from './recipient-routing'

/** Shared action order; supplied readers may be command queries or covered invocation-local facts. */
export function selectBareRecipientOwner(params: {
  handle: string
  senderRunId?: string
  explicitRunId?: string
  boundRuns: () => readonly { id: string }[]
  dispatches: () => Pick<DispatchContextRow, 'id' | 'run_id'>[]
  ownerRunIds: () => string[]
  fallback: () => BareRecipientResolution
}): BareRecipientResolution {
  const { handle } = params
  const boundRuns = params.boundRuns()
  const addressedRunId = params.explicitRunId ?? params.senderRunId
  const boundRun = boundRuns.find((run) => run.id === addressedRunId) ?? boundRuns[0]
  if (boundRun) {
    const mismatch = runMismatch(handle, boundRun.id, params.explicitRunId)
    return mismatch ?? { ok: true, to: `run:${boundRun.id}`, runId: boundRun.id }
  }

  const dispatches = params.dispatches()
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

  const ownerRunIds = params.ownerRunIds()
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

  return params.fallback()
}

function selectDispatch<T extends Pick<DispatchContextRow, 'id' | 'run_id'>>(
  dispatches: T[],
  explicitRunId: string | undefined
): T | undefined {
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

export function runMismatch(
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
