import {
  recordHiddenRendererPtyDataDrop,
  rendererPtyViewDelivery,
  type RendererPtyViewDelivery
} from '../../pty-hidden-delivery-gate'
import type { PendingPtyData } from '../../pty-pending-data-drain-queue'
import {
  makePtyDataPayload,
  sendModelRestoreNeededMarker,
  sendPtyDataToRenderer,
  sendSkippedViewQueries
} from './payload'
import type { PtyIpcSession } from '../session'

/** The stamp for bytes main ingests now, read in the same tick as the runtime's reply-ownership
 *  decision (shouldModelAnswerHiddenPtyQueries), which reads the same mode. */
export function rendererPtyViewDeliveryForIngestion(
  session: PtyIpcSession,
  id: string
): RendererPtyViewDelivery {
  return rendererPtyViewDelivery(id, session.getSettings?.())
}

export function pendingIngestedDelivery(pending: PendingPtyData): RendererPtyViewDelivery {
  return pending.ingestedDelivery ?? 'parse'
}

/** Whether the view was to answer these bytes' queries: only bytes ingested as 'parse'. */
export function viewOwesPendingReplies(pending: PendingPtyData): boolean {
  return pending.ingestedDelivery === undefined
}

/** Drops an entry whose replies were owned outside the view, which restores from main. */
export function dropOwnedOutsideViewPendingPtyData(
  session: PtyIpcSession,
  id: string,
  pending: PendingPtyData
): void {
  if (pending.projectionAdmissionIds) {
    session.sshOutputIntake?.transferProjections(pending.projectionAdmissionIds, 'hidden-drop')
  }
  if (recordHiddenRendererPtyDataDrop(id, pending.data.length).shouldEmitRestoreMarker) {
    sendModelRestoreNeededMarker(
      session,
      id,
      'hidden-drop',
      session.runtime?.getPtyOutputSequence(id)
    )
  }
}

/** Runs before bytes ingested as `delivery` join `id`'s pending entry, so one entry never mixes
 *  reply owners. Returns the entry the bytes may join. */
export function settlePendingDeliveryStamp(
  session: PtyIpcSession,
  id: string,
  delivery: RendererPtyViewDelivery
): PendingPtyData | undefined {
  const pending = session.pendingData.get(id)
  if (!pending || viewOwesPendingReplies(pending) === (delivery === 'parse')) {
    return pending
  }
  if (delivery !== 'parse') {
    // The view stopped parsing before it saw these bytes: answer their queries now, then
    // stamp them like the new bytes so a quick flip back cannot make the view answer again.
    sendSkippedViewQueries(session, id, pending.data)
    const settled: PendingPtyData = {
      ...pending,
      ...(pending.droppedOutput === true ? { data: '' } : {}),
      ingestedDelivery: delivery
    }
    session.setPendingPtyData(id, settled)
    return settled
  }
  // The view parses again with bytes still queued whose replies were owned outside it: they go
  // to sidecars only (the view restores from main) and fresh bytes start anew.
  session.deletePendingPtyData(id)
  session.pendingOverflowMarkedPtys.delete(id)
  if (pending.droppedOutput !== true && pending.data && session.rendererPtyDispatcherReady) {
    sendPtyDataToRenderer(
      session,
      id,
      makePtyDataPayload(
        id,
        pending.data,
        pending.startSeq,
        pending.containsBackgroundOutput,
        pending.rawLength,
        pending.transformed
      ),
      pending.projectionAdmissionIds,
      pendingIngestedDelivery(pending)
    )
  } else {
    dropOwnedOutsideViewPendingPtyData(session, id, pending)
  }
  return undefined
}
