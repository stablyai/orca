import type { LegacySshProjectionSemantics } from '../../ssh-pty-legacy-projection'
import {
  recordHiddenRendererPtyDataDrop,
  shouldDropHiddenRendererPtyData
} from '../../pty-hidden-delivery-gate'
import {
  deliveredHiddenRendererResizeOutputPtys,
  pendingHiddenRendererResizeOutputPtys,
  rendererVisibilityKnownPtys,
  visibleRendererPtys,
  activeRendererPtys
} from './visibility-state'
import { PTY_BATCH_INTERVAL_MS } from './constants'
import { appendPendingPtyData, getDroppedMode2031RendererData } from './pending'
import { sendModelRestoreNeededMarker, sendPtyDataToRenderer } from './payload'
import { shouldSendInteractiveOutputNow } from './interactive'
import { requestDeliveryResyncForGatedPty } from './accounting'
import { warnIfDroppingHiddenBytesForVisiblePty } from './debug-snapshot'
import { clearFlushTimerIfIdle } from './flush'
import type { PtyIpcSession } from '../session'

export function rendererPtyIsKnownHidden(id: string): boolean {
  return rendererVisibilityKnownPtys.has(id) && !visibleRendererPtys.has(id)
}

export function ptyHasHiddenRendererResizeOutput(id: string): boolean {
  return (
    pendingHiddenRendererResizeOutputPtys.has(id) || deliveredHiddenRendererResizeOutputPtys.has(id)
  )
}

export function markHiddenRendererResizeOutputDelivered(id: string): void {
  if (!pendingHiddenRendererResizeOutputPtys.delete(id)) {
    return
  }
  deliveredHiddenRendererResizeOutputPtys.add(id)
}

export function clearDeliveredHiddenRendererResizeOutput(id: string): void {
  deliveredHiddenRendererResizeOutputPtys.delete(id)
}

export function clearHiddenRendererResizeOutput(id: string): void {
  pendingHiddenRendererResizeOutputPtys.delete(id)
  deliveredHiddenRendererResizeOutputPtys.delete(id)
}

export function acceptPtyDataForRenderer(
  session: PtyIpcSession,
  payload: {
    id: string
    data: string
    sequenceChars?: number
    transformed?: boolean
  },
  outputSeq: number | undefined,
  projection?: LegacySshProjectionSemantics
): void {
  const rawLength = payload.sequenceChars ?? payload.data.length
  const preservesSeq = !payload.transformed && rawLength === payload.data.length
  const startSeq = typeof outputSeq === 'number' ? Math.max(0, outputSeq - rawLength) : undefined
  const projectionId = projection?.identity.projectionSemanticsId
  if (session.mainWindow.isDestroyed()) {
    if (projectionId) {
      session.sshOutputIntake?.transferProjections([projectionId], 'renderer-destroyed')
    }
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    session.producerFlowControl.releaseAll()
    session.clearDeliveryResyncProbe()
    session.clearPendingPtyData()
    session.pendingOverflowMarkedPtys.clear()
    session.rendererDeliveryAccountingByPty.clear()
    session.rendererInFlightTotalChars = 0
    session.clearDispatcherReadyWatchdog()
    return
  }
  if (session.rendererExitingPtyIds.has(payload.id)) {
    if (projectionId) {
      session.sshOutputIntake?.transferProjections([projectionId], 'pty-exiting')
    }
    return
  }
  if (shouldDropHiddenRendererPtyData(payload.id, session.getSettings?.())) {
    if (projectionId) {
      session.sshOutputIntake?.transferProjections([projectionId], 'hidden-drop')
    }
    const droppedChars = projection ? rawLength : payload.data.length
    const drop = recordHiddenRendererPtyDataDrop(payload.id, droppedChars)
    warnIfDroppingHiddenBytesForVisiblePty(session, payload.id, droppedChars)
    if (drop.shouldEmitRestoreMarker) {
      sendModelRestoreNeededMarker(session, payload.id, 'hidden-drop', outputSeq)
    }
    return
  }
  if (payload.data.length === 0 && !payload.transformed) {
    if (projectionId) {
      session.sshOutputIntake?.transferProjections([projectionId], 'empty-projection')
    }
    return
  }
  const containsBackgroundOutput =
    rendererPtyIsKnownHidden(payload.id) || ptyHasHiddenRendererResizeOutput(payload.id)
  if (containsBackgroundOutput) {
    markHiddenRendererResizeOutputDelivered(payload.id)
  }
  const overflowMarkedBeforeAppend = session.pendingOverflowMarkedPtys.has(payload.id)
  if (projection?.desktopSpan) {
    session.sourceCreditPendingPtys.add(payload.id)
  }
  const pending = appendPendingPtyData(
    session,
    payload.id,
    session.pendingData.get(payload.id),
    payload.data,
    startSeq,
    preservesSeq,
    containsBackgroundOutput,
    rawLength,
    payload.transformed === true,
    projectionId
  )
  const shouldEmitPendingCapRestoreMarker =
    pending.droppedOutput === true &&
    !overflowMarkedBeforeAppend &&
    session.pendingOverflowMarkedPtys.has(payload.id)
  const nextData = pending.data + getDroppedMode2031RendererData(pending)
  const isInteractiveOutput = shouldSendInteractiveOutputNow(
    payload.id,
    nextData,
    performance.now()
  )
  if (isInteractiveOutput && session.rendererPtyDispatcherReady) {
    if (!session.canSendPtyDataToRenderer(payload.id, { interactive: true })) {
      session.setPendingPtyData(payload.id, pending)
      if (shouldEmitPendingCapRestoreMarker) {
        sendModelRestoreNeededMarker(session, payload.id, 'pending-cap', outputSeq)
      }
      session.updateProducerFlowControl(payload.id)
      requestDeliveryResyncForGatedPty(session)
      return
    }
    session.deletePendingPtyData(payload.id)
    clearFlushTimerIfIdle(session)
    if (shouldEmitPendingCapRestoreMarker) {
      sendModelRestoreNeededMarker(session, payload.id, 'pending-cap', outputSeq)
    }
    session.pendingOverflowMarkedPtys.delete(payload.id)
    try {
      sendPtyDataToRenderer(
        session,
        payload.id,
        {
          id: payload.id,
          data: nextData,
          ...(typeof pending.startSeq === 'number'
            ? {
                seq: pending.startSeq + (pending.rawLength ?? nextData.length),
                rawLength: pending.rawLength ?? nextData.length
              }
            : {}),
          ...(pending.transformed ? { transformed: true } : {}),
          ...(pending.containsBackgroundOutput === true ? { background: true } : {}),
          ...(pending.droppedOutput === true ? { droppedOutput: true } : {})
        },
        pending.projectionAdmissionIds
      )
    } finally {
      session.updateProducerFlowControl(payload.id)
    }
    return
  }
  session.setPendingPtyData(payload.id, pending)
  if (shouldEmitPendingCapRestoreMarker) {
    sendModelRestoreNeededMarker(session, payload.id, 'pending-cap', outputSeq)
  }
  session.updateProducerFlowControl(payload.id)
  if (
    !session.canSendPtyDataToRenderer(payload.id, {
      interactive: activeRendererPtys.has(payload.id)
    })
  ) {
    requestDeliveryResyncForGatedPty(session)
  }
  if (!session.flushTimer) {
    session.schedulePendingDataFlush(PTY_BATCH_INTERVAL_MS)
  }
}
