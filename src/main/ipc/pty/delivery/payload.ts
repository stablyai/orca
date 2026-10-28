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
  transformed = false,
  gapEscapeState?: string
): PtyDataPayload {
  const payload: PtyDataPayload = { id, data }
  if (gapEscapeState) {
    payload.gapEscapeState = gapEscapeState
  }
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
  markerSeq: number | undefined,
  hiddenDropEpisode?: number
): boolean {
  if (!session.mainWindow || session.mainWindow.isDestroyed()) {
    return false
  }
  try {
    session.mainWindow.webContents.send('pty:modelRestoreNeeded', {
      id,
      reason,
      ...(typeof markerSeq === 'number' ? { markerSeq } : {}),
      ...(typeof hiddenDropEpisode === 'number' ? { hiddenDropEpisode } : {})
    })
  } catch (error) {
    // Disposed frames can throw synchronously on this data path.
    console.error('[pty] renderer model-restore marker send failed', error)
    return false
  }
  return true
}

export function sendPtyDataToRenderer(
  session: PtyIpcSession,
  id: string,
  payload: PtyDataPayload
): boolean {
  if (!session.mainWindow) {
    return false
  }
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
    mainDeliveryBreadcrumbs.record('pty-data-send-failed', {
      id: redactPtyIdForDiagnostics(id),
      chars: charCount
    })
    console.error('[pty] renderer data send failed; payload will not be retried', error)
    return false
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
    // Failed sends must leave restore pending.
    session.rendererDeliveryRestoreNeededPtys.delete(id)
  }
  return true
}
