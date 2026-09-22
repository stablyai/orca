import { redactPtyIdForDiagnostics } from '../../../../shared/pty-delivery-diagnostics'
import type { PtyModelRestoreReason } from '../../../../shared/pty-model-restore-marker'
import { mainDeliveryBreadcrumbs } from './debug'
import { recordPtyRendererDeliveryPressure } from './accounting'
import type { PtyDataPayload, PtyIpcSession } from '../session'

export function makePtyDataPayload(
  id: string,
  data: string,
  startSeq: number | undefined,
  containsBackgroundOutput: boolean | undefined,
  rawLength = data.length,
  transformed = false
): PtyDataPayload {
  const payload: PtyDataPayload = { id, data }
  if (typeof startSeq === 'number') {
    payload.seq = startSeq + rawLength
  }
  if (typeof startSeq === 'number' || rawLength !== data.length || transformed) {
    payload.rawLength = rawLength
  }
  if (transformed) {
    payload.transformed = true
  }
  if (containsBackgroundOutput === true) {
    payload.background = true
  }
  return payload
}

export function getPtyPayloadCharCount(payload: { data: string; rawLength?: number }): number {
  return Math.max(0, payload.rawLength ?? payload.data.length)
}

export function sendModelRestoreNeededMarker(
  session: PtyIpcSession,
  id: string,
  reason: PtyModelRestoreReason,
  markerSeq: number | undefined
): boolean {
  if (session.mainWindow.isDestroyed()) {
    return false
  }
  try {
    session.mainWindow.webContents.send('pty:modelRestoreNeeded', {
      id,
      reason,
      ...(typeof markerSeq === 'number' ? { markerSeq } : {})
    })
  } catch (error) {
    // Why: a disposed render frame throws synchronously here, and this rides the data path.
    console.error('[pty] renderer model-restore marker send failed', error)
    return false
  }
  return true
}

export function sendPtyDataToRenderer(
  session: PtyIpcSession,
  id: string,
  payload: PtyDataPayload,
  projectionAdmissionIds?: readonly string[]
): { sent: boolean; projectionsTransferred: boolean } {
  const charCount = getPtyPayloadCharCount(payload)
  const accounting = session.rendererDeliveryAccountingByPty.get(id)
  const hadAccounting = accounting !== undefined
  if (accounting) {
    accounting.sentChars += charCount
    accounting.lastSendAtMs = Date.now()
  } else {
    session.rendererDeliveryAccountingByPty.set(id, {
      sentChars: charCount,
      ackedChars: 0,
      lastSendAtMs: Date.now(),
      lastAckAtMs: null
    })
  }
  session.rendererInFlightTotalChars += charCount
  recordPtyRendererDeliveryPressure(session, id)
  try {
    session.mainWindow.webContents.send('pty:data', payload)
  } catch (error) {
    const current = session.rendererDeliveryAccountingByPty.get(id)
    if (current) {
      const inFlightBeforeRollback = current.sentChars - current.ackedChars
      current.sentChars = Math.max(0, current.sentChars - charCount)
      current.ackedChars = Math.min(current.ackedChars, current.sentChars)
      const inFlightAfterRollback = current.sentChars - current.ackedChars
      session.rendererInFlightTotalChars = Math.max(
        0,
        session.rendererInFlightTotalChars - (inFlightBeforeRollback - inFlightAfterRollback)
      )
      if (!hadAccounting && current.sentChars === 0) {
        session.rendererDeliveryAccountingByPty.delete(id)
      }
    }
    session.rendererDeliveryRestoreNeededPtys.add(id)
    if (projectionAdmissionIds) {
      session.sshOutputIntake?.transferProjections(projectionAdmissionIds, 'renderer-send-failed')
    }
    mainDeliveryBreadcrumbs.record('pty-data-send-failed', {
      id: redactPtyIdForDiagnostics(id),
      chars: charCount
    })
    console.error('[pty] renderer data send failed; payload will not be retried', error)
    return { sent: false, projectionsTransferred: projectionAdmissionIds !== undefined }
  }
  let projectionsTransferred = false
  if (projectionAdmissionIds) {
    try {
      session.sshOutputIntake?.publishProjectionPrefix(
        projectionAdmissionIds,
        payload.data.length,
        charCount
      )
    } catch {
      session.sshOutputIntake?.transferProjections(
        projectionAdmissionIds,
        'projection-publish-failed'
      )
      projectionsTransferred = true
    }
  }
  if (
    session.rendererDeliveryRestoreNeededPtys.has(id) &&
    sendModelRestoreNeededMarker(
      session,
      id,
      'delivery-heal',
      session.runtime?.getPtyOutputSequence(id)
    )
  ) {
    // Why cleared only on a successful send: an unsent marker leaves the restore pending.
    session.rendererDeliveryRestoreNeededPtys.delete(id)
  }
  return { sent: true, projectionsTransferred }
}
