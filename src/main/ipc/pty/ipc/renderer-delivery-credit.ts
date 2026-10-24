import type { WebContents } from 'electron'
import { getPtyIpc } from '../../pty-host-bindings'
import type {
  PtyDeliveryWriteOff,
  PtyRendererDeliveryHealthReply,
  PtyRendererDeliveryStateReport
} from '../../../../shared/pty-renderer-delivery-health'
import type { PtyIpcSession } from '../session'
import { tryGetProviderForPty } from '../provider/registry'
import { applyCumulativeAck, resetPtyRendererDeliveryAccounting } from '../delivery/accounting'
import { resetRendererDeliveryAccountingForLifecycleReset } from '../delivery/debug'
import { PTY_DELIVERY_HEAL_MIN_ACK_SILENCE_MS } from '../delivery/constants'
import { isMainWindowPtyIpcEvent } from './write-input'

function credit(session: PtyIpcSession, id: string, total: number): number {
  const acknowledged = applyCumulativeAck(session, id, Math.max(0, total))
  if (!session.options?.rendererDeliveryOnly) {
    tryGetProviderForPty(id)?.acknowledgeDataEvent(id, acknowledged)
  }
  return acknowledged
}

function mergeProcessed(
  session: PtyIpcSession,
  totals: Record<string, number> | undefined
): boolean {
  let credited = false
  for (const [id, total] of Object.entries(totals ?? {})) {
    if (typeof total === 'number' && Number.isFinite(total)) {
      credited = credit(session, id, total) > 0 || credited
    }
  }
  return credited
}

function openDeliveryGate(session: PtyIpcSession): void {
  session.clearDispatcherReadyWatchdog()
  session.rendererPtyDispatcherReady = true
  session.pendingData.reactivateBlocked()
  session.schedulePendingDataFlush(0)
}

export function installPtyRendererDeliveryCreditIpc(source: PtyIpcSession): void {
  const ipcMain = getPtyIpc()
  const native = source.options?.nativeWindowDelivery
  const deliveryFor = (renderer: WebContents | undefined): PtyIpcSession | null =>
    native ? (renderer ? native.sessionFor(renderer) : null) : source

  ipcMain.removeAllListeners('pty:ackData')
  ipcMain.on(
    'pty:ackData',
    (event, args: { id: string; charCount?: number; processedChars?: number }) => {
      const session = deliveryFor(event?.sender)
      if (!session) {
        return
      }
      session.lastAckReceivedAtMs = Date.now()
      session.deliveryResyncUnansweredWarnLogged = false
      const previous = session.rendererDeliveryAccountingByPty.get(args.id)?.ackedChars ?? 0
      const total =
        typeof args.processedChars === 'number' && Number.isFinite(args.processedChars)
          ? args.processedChars
          : previous + (Number.isFinite(args.charCount) ? Math.max(0, args.charCount ?? 0) : 0)
      session.schedulePendingDataAfterCreditReport(credit(session, args.id, total) > 0)
    }
  )

  ipcMain.removeAllListeners('pty:deliveryResyncResponse')
  ipcMain.on(
    'pty:deliveryResyncResponse',
    (event, args: { requestId: number; processedCharsByPty: Record<string, number> }) => {
      const session = deliveryFor(event?.sender)
      if (
        !session ||
        session.deliveryResyncOutstandingRequestId === null ||
        args?.requestId !== session.deliveryResyncOutstandingRequestId
      ) {
        return
      }
      session.clearDeliveryResyncProbe()
      session.deliveryResyncUnansweredWarnLogged = false
      session.schedulePendingDataAfterCreditReport(
        mergeProcessed(session, args.processedCharsByPty)
      )
    }
  )

  ipcMain.removeHandler('pty:reportRendererDeliveryState')
  ipcMain.handle(
    'pty:reportRendererDeliveryState',
    (event, args: PtyRendererDeliveryStateReport): PtyRendererDeliveryHealthReply => {
      const session = deliveryFor(event?.sender)
      if (!session) {
        return { inFlightTotalChars: 0, inFlightPtyCount: 0, msSinceLastAck: null }
      }
      let credited = mergeProcessed(session, args?.processedCharsByPty)
      let writtenOff: PtyDeliveryWriteOff[] = []
      if (
        args?.heal === true &&
        session.rendererInFlightTotalChars > 0 &&
        (session.lastAckReceivedAtMs === null ||
          Date.now() - session.lastAckReceivedAtMs >= PTY_DELIVERY_HEAL_MIN_ACK_SILENCE_MS)
      ) {
        writtenOff = session.writeOffLostRendererDelivery(args)
        credited ||= writtenOff.length > 0
      }
      session.schedulePendingDataAfterCreditReport(credited)
      return {
        inFlightTotalChars: session.rendererInFlightTotalChars,
        inFlightPtyCount: [...session.rendererDeliveryAccountingByPty.values()].filter(
          (accounting) => accounting.sentChars > accounting.ackedChars
        ).length,
        msSinceLastAck:
          session.lastAckReceivedAtMs === null ? null : Date.now() - session.lastAckReceivedAtMs,
        ...(writtenOff.length > 0 ? { writtenOff } : {})
      }
    }
  )

  ipcMain.removeAllListeners('pty:rendererDispatcherReady')
  ipcMain.on('pty:rendererDispatcherReady', (event) => {
    if (!isMainWindowPtyIpcEvent(event, source.mainWindow)) {
      return
    }
    const session = deliveryFor(event.sender)
    if (!session) {
      return
    }
    if (session.rendererPtyDispatcherReady) {
      if (native) {
        resetPtyRendererDeliveryAccounting(session, false)
      } else {
        resetRendererDeliveryAccountingForLifecycleReset()
      }
    }
    openDeliveryGate(source)
    if (session !== source) {
      openDeliveryGate(session)
    }
  })
}
