import {
  recordHiddenRendererPtyDataDrop,
  shouldDropHiddenRendererPtyData
} from './pty-hidden-delivery-gate'
import {
  rendererVisibilityKnownPtys,
  visibleRendererPtys,
  activeRendererPtys
} from './visibility-state'
import { PTY_BATCH_INTERVAL_MS } from './constants'
import {
  appendPendingPtyData,
  makeDroppedOutputPayload,
  toDroppedOutputSentinel,
  getDroppedMode2031RendererData,
  getDroppedSynchronizedOutputRendererData
} from './pending'
import { sendModelRestoreNeededMarker, sendPtyDataToRenderer } from './payload'
import { shouldSendInteractiveOutputNow } from './interactive'
import { requestDeliveryResyncForGatedPty } from './accounting'
import { warnIfDroppingHiddenBytesForVisiblePty } from './debug-snapshot'
import { clearFlushTimerIfIdle } from './flush'
import { advancePtyEscapeBoundary, escapeBoundaryFields } from './pty-escape-boundary'
import type { PtyIpcSession } from '../session'
import type { PendingPtyData } from './pty-pending-data-drain-contract'

export function rendererPtyIsKnownHidden(id: string): boolean {
  return rendererVisibilityKnownPtys.has(id) && !visibleRendererPtys.has(id)
}

/**
 * Bytes queued before a gap must not be batched with bytes after it: the batch would claim the
 * pre-gap start boundary for a post-gap tail. Like the pending cap, keep only the queries and mode
 * state it carried; the renderer restores the gap from a snapshot.
 */
export function discardPendingPtyDataAcrossGap(session: PtyIpcSession, id: string): void {
  const pending = session.pendingData.get(id)
  if (!pending) {
    return
  }
  let sentinel = asDropSentinel(session, pending)
  // Bytes after the gap cannot continue a partial mode-2031 reply from before it, even one an
  // earlier drop's sentinel still carries.
  if (sentinel.droppedMode2031ScanState?.tail) {
    sentinel = {
      ...sentinel,
      droppedMode2031ScanState: { ...sentinel.droppedMode2031ScanState, tail: '' }
    }
  }
  if (sentinel !== pending) {
    session.setPendingPtyData(id, sentinel)
    session.updateProducerFlowControl(id)
  }
}

function asDropSentinel(session: PtyIpcSession, pending: PendingPtyData): PendingPtyData {
  if (pending.droppedOutput === true) {
    return pending
  }
  session.pendingDroppedChars += pending.data.length
  return toDroppedOutputSentinel(pending)
}

export function acceptPtyDataForRenderer(
  session: PtyIpcSession,
  payload: {
    id: string
    data: string
    sequenceChars?: number
    transformed?: boolean
  },
  outputSeq: number | undefined
): void {
  const rawLength = payload.sequenceChars ?? payload.data.length
  const preservesSeq = !payload.transformed && rawLength === payload.data.length
  const startSeq = typeof outputSeq === 'number' ? Math.max(0, outputSeq - rawLength) : undefined
  // Advance before any early return: bytes accepted without a renderer still move the stream's parser.
  // Zero-sequence payloads are query copies salvaged from a provider gap, not stream bytes.
  const isQueryCopy = payload.sequenceChars === 0
  const startEscapeState = isQueryCopy ? '' : advancePtyEscapeBoundary(payload.id, payload.data)
  if (!session.mainWindow || session.mainWindow.isDestroyed()) {
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
    return
  }
  if (shouldDropHiddenRendererPtyData(payload.id, session.getSettings?.())) {
    discardPendingPtyDataAcrossGap(session, payload.id)
    const droppedChars = payload.data.length
    const drop = recordHiddenRendererPtyDataDrop(payload.id, droppedChars)
    warnIfDroppingHiddenBytesForVisiblePty(session, payload.id, droppedChars)
    if (drop.shouldEmitRestoreMarker) {
      sendModelRestoreNeededMarker(
        session,
        payload.id,
        'hidden-drop',
        outputSeq,
        drop.hiddenDropEpisode
      )
    }
    return
  }
  if (payload.data.length === 0 && !payload.transformed) {
    return
  }
  const containsBackgroundOutput = rendererPtyIsKnownHidden(payload.id)
  const overflowMarkedBeforeAppend = session.pendingOverflowMarkedPtys.has(payload.id)
  const queued = session.pendingData.get(payload.id)
  const pending = appendPendingPtyData(
    session,
    payload.id,
    // Query copies ride the drop sentinel: the renderer answers them without treating them as stream bytes.
    isQueryCopy
      ? queued
        ? asDropSentinel(session, queued)
        : { data: '', droppedOutput: true }
      : queued,
    payload.data,
    startSeq,
    preservesSeq,
    containsBackgroundOutput,
    rawLength,
    payload.transformed === true,
    startEscapeState
  )
  const shouldEmitPendingCapRestoreMarker =
    pending.droppedOutput === true &&
    !overflowMarkedBeforeAppend &&
    session.pendingOverflowMarkedPtys.has(payload.id)
  // Emit DEC 2026 release first; an ESC after the salvaged partial mode-2031 CSI would abort its continuation.
  const nextData =
    pending.data +
    getDroppedSynchronizedOutputRendererData(pending) +
    getDroppedMode2031RendererData(pending)
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
        pending.droppedOutput === true
          ? makeDroppedOutputPayload(payload.id, pending)
          : {
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
              ...escapeBoundaryFields(pending.startEscapeState)
            }
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
