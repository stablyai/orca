/**
 * `pty:reportRendererDeliveryState` — the renderer-initiated health report and its write-off
 * lane, moved out of the IPC installer so the delivery decisions live with the accounting.
 */
import type {
  PtyDeliveryStalledPty,
  PtyDeliveryWriteOff,
  PtyRendererDeliveryHealthReply,
  PtyRendererDeliveryStateReport
} from '../../../../shared/pty-renderer-delivery-health'
import { tryGetProviderForPty } from '../provider/registry'
import {
  applyCumulativeAck,
  collectAckSilentPtyIdsForHeal,
  hasAckSilentRendererDeliveryDebt,
  hasUnreceivedRendererDelivery,
  isPtyAckSilentForHeal
} from './accounting'
import { DELIVERY_DIAGNOSTICS_MAX_PTYS } from './constants'
import type { PtyIpcSession } from '../session'

/** Max-merge the renderer's cumulative processed totals: they are authoritative for what it
 *  parsed, so this drains exactly the debt lost ACKs left behind. Returns whether anything
 *  was credited. Shared by the resync response and the health report — a heal is only reached
 *  once merging cannot drain. */
export function applyRendererProcessedCharTotals(
  session: PtyIpcSession,
  processedCharsByPty: Record<string, number> | undefined
): boolean {
  let creditedAny = false
  for (const [id, processedChars] of Object.entries(processedCharsByPty ?? {})) {
    if (typeof processedChars !== 'number' || !Number.isFinite(processedChars)) {
      continue
    }
    const acknowledged = applyCumulativeAck(session, id, Math.max(0, processedChars))
    if (acknowledged > 0) {
      creditedAny = true
      tryGetProviderForPty(id)?.acknowledgeDataEvent(id, acknowledged)
    }
  }
  return creditedAny
}

/** Prioritize recoverable debt before capping so streaming or parsing siblings cannot hide it. */
function collectStalledPtys(
  session: PtyIpcSession,
  receivedCharsByPty: Record<string, number> | undefined
): {
  stalledPtys: PtyDeliveryStalledPty[]
  inFlightPtyCount: number
} {
  const now = Date.now()
  const stalled: PtyDeliveryStalledPty[] = []
  const recoverablePtyIds = new Set<string>()
  for (const [id, accounting] of session.rendererDeliveryAccountingByPty) {
    const inFlightChars = accounting.sentChars - accounting.ackedChars
    if (inFlightChars > 0) {
      if (
        isPtyAckSilentForHeal(accounting, now) &&
        hasUnreceivedRendererDelivery(accounting, receivedCharsByPty?.[id])
      ) {
        recoverablePtyIds.add(id)
      }
      stalled.push({
        id,
        inFlightChars,
        msSinceLastAck: accounting.lastAckAtMs === null ? null : now - accounting.lastAckAtMs
      })
    }
  }
  stalled.sort(
    (a, b) =>
      Number(recoverablePtyIds.has(b.id)) - Number(recoverablePtyIds.has(a.id)) ||
      b.inFlightChars - a.inFlightChars
  )
  return {
    stalledPtys: stalled.slice(0, DELIVERY_DIAGNOSTICS_MAX_PTYS),
    inFlightPtyCount: stalled.length
  }
}

export function handleRendererDeliveryStateReport(
  session: PtyIpcSession,
  args: PtyRendererDeliveryStateReport | undefined
): PtyRendererDeliveryHealthReply {
  // Sampled before the merge below: crediting a recovered cumulative total stamps that PTY's
  // lastAckAtMs, which would read as a live ACK and veto the very heal this report requested.
  const ackSilentPtyIds = collectAckSilentPtyIdsForHeal(session)
  let creditedAny = applyRendererProcessedCharTotals(session, args?.processedCharsByPty)
  let writtenOff: PtyDeliveryWriteOff[] = []
  // Why main must also see ACK silence: it stops a buggy or foreign caller from writing off
  // live delivery. The gate is per-PTY because the session-global one it replaced never
  // opened on a busy machine, leaving a wedged pane's debt permanently unhealable.
  if (args?.heal === true && hasAckSilentRendererDeliveryDebt(session, ackSilentPtyIds)) {
    writtenOff = session.writeOffLostRendererDelivery(args, ackSilentPtyIds)
    creditedAny ||= writtenOff.length > 0
  }
  session.schedulePendingDataAfterCreditReport(creditedAny)
  const { stalledPtys, inFlightPtyCount } = collectStalledPtys(session, args?.receivedCharsByPty)
  return {
    inFlightTotalChars: session.rendererInFlightTotalChars,
    inFlightPtyCount,
    msSinceLastAck:
      session.lastAckReceivedAtMs === null ? null : Date.now() - session.lastAckReceivedAtMs,
    ...(writtenOff.length > 0 ? { writtenOff } : {}),
    ...(stalledPtys.length > 0 ? { stalledPtys } : {})
  }
}
