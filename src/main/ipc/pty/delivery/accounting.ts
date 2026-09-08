import type {
  PtyDeliveryWriteOff,
  PtyRendererDeliveryStateReport
} from '../../../../shared/pty-renderer-delivery-health'
import { tryGetProviderForPty } from '../provider/registry'
import { mainDeliveryBreadcrumbs } from './debug'
import {
  PTY_DELIVERY_RESYNC_TIMEOUT_MS,
  PTY_RENDERER_ACTIVE_PTY_IN_FLIGHT_RESERVE_CHARS,
  PTY_RENDERER_INTERACTIVE_RESERVE_CHARS,
  PTY_RENDERER_IN_FLIGHT_HIGH_WATER_CHARS,
  PTY_RENDERER_TOTAL_IN_FLIGHT_HIGH_WATER_CHARS
} from './constants'
import type { PtyIpcSession } from '../session'
import type { PendingPtyData } from '../../pty-pending-data-drain-queue'

export function getRendererInFlightCharsForPty(session: PtyIpcSession, id: string): number {
  const accounting = session.rendererDeliveryAccountingByPty.get(id)
  return accounting ? accounting.sentChars - accounting.ackedChars : 0
}

export function recordPtyRendererDeliveryPressure(session: PtyIpcSession, id: string): void {
  session.peakPendingChars = Math.max(
    session.peakPendingChars,
    session.pendingData.totalPendingChars
  )
  session.peakMaxPendingCharsByPty = Math.max(
    session.peakMaxPendingCharsByPty,
    session.pendingData.get(id)?.data.length ?? 0
  )
  session.peakRendererInFlightChars = Math.max(
    session.peakRendererInFlightChars,
    session.rendererInFlightTotalChars
  )
  session.peakMaxRendererInFlightCharsByPty = Math.max(
    session.peakMaxRendererInFlightCharsByPty,
    getRendererInFlightCharsForPty(session, id)
  )
}

export function setPendingPtyData(
  session: PtyIpcSession,
  id: string,
  pending: PendingPtyData
): void {
  session.pendingData.set(id, pending)
  recordPtyRendererDeliveryPressure(session, id)
}

export function deletePendingPtyData(session: PtyIpcSession, id: string): void {
  session.pendingData.delete(id)
}

export function clearPendingPtyData(session: PtyIpcSession): void {
  for (const pending of session.pendingData.values()) {
    if (pending.projectionAdmissionIds) {
      session.sshOutputIntake?.transferProjections(
        pending.projectionAdmissionIds,
        'renderer-lifecycle-reset'
      )
    }
  }
  session.pendingData.clear()
  session.sourceCreditPendingPtys.clear()
}

export function canSendPtyDataToRenderer(
  session: PtyIpcSession,
  id: string,
  options: { interactive?: boolean } = {}
): boolean {
  const totalLimit =
    PTY_RENDERER_TOTAL_IN_FLIGHT_HIGH_WATER_CHARS +
    (options.interactive === true ? PTY_RENDERER_INTERACTIVE_RESERVE_CHARS : 0)
  // Why per-PTY (not global) reserve: keep one active pane responsive without letting every background pane burst past the cap.
  const ptyLimit =
    PTY_RENDERER_IN_FLIGHT_HIGH_WATER_CHARS +
    (options.interactive === true ? PTY_RENDERER_ACTIVE_PTY_IN_FLIGHT_RESERVE_CHARS : 0)
  return (
    getRendererInFlightCharsForPty(session, id) < ptyLimit &&
    session.rendererInFlightTotalChars < totalLimit
  )
}

export function applyCumulativeAck(
  session: PtyIpcSession,
  id: string,
  processedChars: number
): number {
  const accounting = session.rendererDeliveryAccountingByPty.get(id)
  if (!accounting) {
    return 0
  }
  // Clamped to sentChars so a corrupt payload cannot drive in-flight negative.
  const nextAckedChars = Math.min(
    accounting.sentChars,
    Math.max(accounting.ackedChars, processedChars)
  )
  const acknowledged = nextAckedChars - accounting.ackedChars
  accounting.ackedChars = nextAckedChars
  if (acknowledged > 0) {
    accounting.lastAckAtMs = Date.now()
  }
  session.rendererInFlightTotalChars = Math.max(
    0,
    session.rendererInFlightTotalChars - acknowledged
  )
  if (acknowledged > 0) {
    session.sshOutputIntake?.settleProjectionPrefix(id, acknowledged)
  }
  return acknowledged
}

export function schedulePendingDataAfterCreditReport(
  session: PtyIpcSession,
  creditedAny: boolean
): void {
  if (creditedAny) {
    session.pendingData.reactivateBlocked()
  }
  if (session.pendingData.size > 0 && !session.flushTimer) {
    session.schedulePendingDataFlush(0)
  }
}

export function clearDeliveryResyncProbe(session: PtyIpcSession): void {
  session.deliveryResyncOutstandingRequestId = null
  if (session.deliveryResyncTimer) {
    clearTimeout(session.deliveryResyncTimer)
    session.deliveryResyncTimer = null
  }
}

export function requestDeliveryResyncForGatedPty(session: PtyIpcSession): void {
  if (session.deliveryResyncOutstandingRequestId !== null || session.mainWindow.isDestroyed()) {
    return
  }
  session.deliveryResyncRequestSerial += 1
  const requestId = session.deliveryResyncRequestSerial
  session.deliveryResyncOutstandingRequestId = requestId
  session.deliveryResyncTimer = setTimeout(() => {
    if (session.deliveryResyncOutstandingRequestId !== requestId) {
      return
    }
    clearDeliveryResyncProbe(session)
    // Why no mutation on timeout: unanswered means dead IPC that only a reload cures; log once per silent streak to avoid spamming every probe.
    if (session.deliveryResyncUnansweredWarnLogged) {
      return
    }
    session.deliveryResyncUnansweredWarnLogged = true
    console.warn('[pty] delivery resync probe unanswered — renderer IPC unresponsive', {
      msSinceLastAck:
        session.lastAckReceivedAtMs === null ? null : Date.now() - session.lastAckReceivedAtMs,
      ...session.readCurrentPtyRendererDeliveryDebugSnapshot()
    })
  }, PTY_DELIVERY_RESYNC_TIMEOUT_MS)
  session.deliveryResyncTimer.unref?.()
  session.mainWindow.webContents.send('pty:requestDeliveryResync', { requestId })
}

export function writeOffLostRendererDelivery(
  session: PtyIpcSession,
  report: PtyRendererDeliveryStateReport
): PtyDeliveryWriteOff[] {
  const writtenOff: PtyDeliveryWriteOff[] = []
  for (const [id, accounting] of session.rendererDeliveryAccountingByPty) {
    if (accounting.sentChars - accounting.ackedChars <= 0) {
      continue
    }
    const received = report.receivedCharsByPty?.[id]
    const receivedChars =
      typeof received === 'number' && Number.isFinite(received) ? Math.max(0, received) : 0
    // Why skip: received-but-unparsed bytes are alive in the renderer write queue; their deferred ACK still repays this debt.
    if (receivedChars > accounting.ackedChars) {
      continue
    }
    const acknowledged = applyCumulativeAck(session, id, accounting.sentChars)
    if (acknowledged <= 0) {
      continue
    }
    tryGetProviderForPty(id)?.acknowledgeDataEvent(id, acknowledged)
    // Why drop pending: everything at/before markerSeq comes from the snapshot, so flushing pre-marker bytes would double-paint the restore.
    const pending = session.pendingData.get(id)
    if (pending) {
      if (pending.projectionAdmissionIds) {
        session.sshOutputIntake?.transferProjections(
          pending.projectionAdmissionIds,
          'renderer-delivery-writeoff'
        )
      }
      session.pendingDroppedChars += pending.data.length
      deletePendingPtyData(session, id)
      session.pendingOverflowMarkedPtys.delete(id)
      session.updateProducerFlowControl(id)
    }
    const markerSeq = session.runtime?.getPtyOutputSequence(id)
    writtenOff.push({
      id,
      ...(typeof markerSeq === 'number' ? { markerSeq } : {}),
      writtenOffChars: acknowledged
    })
  }
  if (writtenOff.length > 0) {
    clearDeliveryResyncProbe(session)
    session.deliveryResyncUnansweredWarnLogged = false
    mainDeliveryBreadcrumbs.record('delivery-heal-writeoff', {
      writtenOffPtyCount: writtenOff.length,
      writtenOffChars: writtenOff.reduce((sum, { writtenOffChars }) => sum + writtenOffChars, 0)
    })
    console.warn('[pty] delivery heal: wrote off renderer-bound bytes lost in push channel', {
      rendererPtyDataListenerCount: report.rendererPtyDataListenerCount ?? null,
      msSinceLastAck:
        session.lastAckReceivedAtMs === null ? null : Date.now() - session.lastAckReceivedAtMs,
      writtenOffByPty: writtenOff.map(({ id, writtenOffChars }) => ({ id, writtenOffChars })),
      ...session.readCurrentPtyRendererDeliveryDebugSnapshot()
    })
  }
  return writtenOff
}
