import { getPtyIpc } from '../../pty-host-bindings'
import type {
  PtyDeliveryWriteOff,
  PtyRendererDeliveryHealthReply,
  PtyRendererDeliveryStateReport
} from '../../../../shared/pty-renderer-delivery-health'
import { redactPtyIdForDiagnostics } from '../../../../shared/pty-delivery-diagnostics'
import { installTerminalViewAttributesIpc } from './terminal-view-attributes-ipc'
import {
  consumeHiddenRendererPtyDropMemory,
  recordHiddenRendererPtyDataDrop,
  setRendererPtyDeliveryInterest,
  shouldDropHiddenRendererPtyData
} from '../../pty-hidden-delivery-gate'
import { tryGetProviderForPty, closeStartupQueryAuthorityForPty } from '../provider/registry'
import {
  activeRendererPtys,
  invalidatePendingPtyDrainPolicy,
  invalidatePendingPtyDrainPriority,
  ptySizes,
  rendererVisibilityKnownPtys,
  visibleRendererPtys
} from '../delivery/visibility-state'
import {
  mainDeliveryBreadcrumbs,
  resetRendererDeliveryAccountingForLifecycleReset
} from '../delivery/debug'
import { PTY_DELIVERY_HEAL_MIN_ACK_SILENCE_MS } from '../delivery/constants'
import { applyCumulativeAck } from '../delivery/accounting'
import { sendModelRestoreNeededMarker } from '../delivery/payload'
import { isMainWindowPtyIpcEvent } from './write-input'
import { acknowledgePaintedColdRestore } from './painted-cold-restore-ack'
import type { PaintedRestoreAck } from '../../../../shared/painted-restore-ack'
import type { PtyIpcSession } from '../session'

export function installPtyResizeVisibilityIpc(session: PtyIpcSession): void {
  const ipcMain = getPtyIpc()
  const { runtime, mainWindow } = session

  // Fire-and-forget resize avoids an empty acknowledgement round trip.
  ipcMain.removeAllListeners('pty:resize')
  ipcMain.on('pty:resize', (_event, args: { id: string; cols: number; rows: number }) => {
    // Fit overrides remeasure all panes; suppress the cascade so background full-width measurements cannot resize PTYs.
    if (runtime?.isResizeSuppressed()) {
      return
    }
    // Enforce viewer-owned geometry in main too; renderer presence state lags by one IPC hop (docs/mobile-presence-lock.md).
    const mobileOwnsResize = runtime?.getDriver(args.id).kind === 'mobile'
    const remoteDesktopOwnsResize = runtime?.isRemoteDesktopResizeDriven?.(args.id) === true
    if (mobileOwnsResize || remoteDesktopOwnsResize) {
      if (remoteDesktopOwnsResize) {
        runtime?.recordRemoteDesktopHostReclaimTarget(args.id, args.cols, args.rows)
      }
      return
    }
    const provider = tryGetProviderForPty(args.id)
    if (!provider) {
      return
    }
    try {
      provider.resize(args.id, args.cols, args.rows)
    } catch {
      return
    }
    ptySizes.set(args.id, { cols: args.cols, rows: args.rows })
    runtime?.onExternalPtyResize(args.id, args.cols, args.rows)
  })

  // Measurement-only reports update desktop restore geometry while viewer-owned resizing is blocked (docs/mobile-fit-hold.md).
  ipcMain.removeAllListeners('pty:reportGeometry')
  ipcMain.on('pty:reportGeometry', (_event, args: { id: string; cols: number; rows: number }) => {
    runtime?.recordRendererGeometry(args.id, args.cols, args.rows)
  })

  // Painted-restore acknowledgement clears daemon cold-restore cache without a response.
  ipcMain.removeAllListeners('pty:ackColdRestore')
  ipcMain.on('pty:ackColdRestore', (_event, args: Partial<PaintedRestoreAck> | undefined) => {
    acknowledgePaintedColdRestore(args, (pane, ptyId) =>
      Boolean(runtime?.isRestoredPaneBoundTo(pane, ptyId))
    )
  })

  // Snapshot requests may outlive their pane; retire drop memory only after painted restore (#15504).
  ipcMain.removeAllListeners('pty:hiddenOutputRestoreApplied')
  ipcMain.on(
    'pty:hiddenOutputRestoreApplied',
    (_event, args: { id?: unknown; hiddenDropEpisode?: unknown }) => {
      if (typeof args?.id !== 'string' || !args.id) {
        return
      }
      const episode =
        typeof args.hiddenDropEpisode === 'number' ? args.hiddenDropEpisode : undefined
      consumeHiddenRendererPtyDropMemory(args.id, episode)
    }
  )

  // Bound renderer delivery independently of provider/runtime ingestion.
  ipcMain.removeAllListeners('pty:ackData')
  ipcMain.on(
    'pty:ackData',
    (_event, args: { id: string; charCount?: number; processedChars?: number }) => {
      session.lastAckReceivedAtMs = Date.now()
      // A live ACK ends the prior silent diagnostic streak.
      session.deliveryResyncUnansweredWarnLogged = false
      let acknowledged = 0
      if (typeof args.processedChars === 'number' && Number.isFinite(args.processedChars)) {
        acknowledged = applyCumulativeAck(session, args.id, Math.max(0, args.processedChars))
      } else {
        // Hot reload can pair a legacy delta-ACK renderer with a newer main.
        const accounting = session.rendererDeliveryAccountingByPty.get(args.id)
        const delta = Number.isFinite(args.charCount) ? Math.max(0, args.charCount ?? 0) : 0
        acknowledged = accounting
          ? applyCumulativeAck(session, args.id, accounting.ackedChars + delta)
          : 0
      }
      tryGetProviderForPty(args.id)?.acknowledgeDataEvent(args.id, acknowledged)
      session.schedulePendingDataAfterCreditReport(acknowledged > 0)
    }
  )

  ipcMain.removeAllListeners('pty:deliveryResyncResponse')
  ipcMain.on(
    'pty:deliveryResyncResponse',
    (_event, args: { requestId: number; processedCharsByPty: Record<string, number> }) => {
      if (
        session.deliveryResyncOutstandingRequestId === null ||
        args?.requestId !== session.deliveryResyncOutstandingRequestId
      ) {
        return
      }
      session.clearDeliveryResyncProbe()
      session.deliveryResyncUnansweredWarnLogged = false
      // Max-merge cumulative processed totals to repay debt from lost ACKs.
      let creditedAny = false
      for (const [id, processedChars] of Object.entries(args.processedCharsByPty ?? {})) {
        if (typeof processedChars !== 'number' || !Number.isFinite(processedChars)) {
          continue
        }
        const acknowledged = applyCumulativeAck(session, id, Math.max(0, processedChars))
        if (acknowledged > 0) {
          creditedAny = true
          tryGetProviderForPty(id)?.acknowledgeDataEvent(id, acknowledged)
        }
      }
      session.schedulePendingDataAfterCreditReport(creditedAny)
    }
  )

  // Renderer invoke can survive broken push channels; use it for delivery resync and explicit repair.
  ipcMain.removeHandler('pty:reportRendererDeliveryState')
  ipcMain.handle(
    'pty:reportRendererDeliveryState',
    (_event, args: PtyRendererDeliveryStateReport): PtyRendererDeliveryHealthReply => {
      // Merge cumulative totals before deciding whether lost delivery needs write-off.
      let creditedAny = false
      for (const [id, processedChars] of Object.entries(args?.processedCharsByPty ?? {})) {
        if (typeof processedChars !== 'number' || !Number.isFinite(processedChars)) {
          continue
        }
        const acknowledged = applyCumulativeAck(session, id, Math.max(0, processedChars))
        if (acknowledged > 0) {
          creditedAny = true
          tryGetProviderForPty(id)?.acknowledgeDataEvent(id, acknowledged)
        }
      }
      let writtenOff: PtyDeliveryWriteOff[] = []
      // Require main-observed ACK silence before allowing a caller to write off delivery.
      if (
        args?.heal === true &&
        session.rendererInFlightTotalChars > 0 &&
        (session.lastAckReceivedAtMs === null ||
          Date.now() - session.lastAckReceivedAtMs >= PTY_DELIVERY_HEAL_MIN_ACK_SILENCE_MS)
      ) {
        writtenOff = session.writeOffLostRendererDelivery(args)
        creditedAny ||= writtenOff.length > 0
      }
      session.schedulePendingDataAfterCreditReport(creditedAny)
      let inFlightPtyCount = 0
      for (const accounting of session.rendererDeliveryAccountingByPty.values()) {
        if (accounting.sentChars - accounting.ackedChars > 0) {
          inFlightPtyCount++
        }
      }
      return {
        inFlightTotalChars: session.rendererInFlightTotalChars,
        inFlightPtyCount,
        msSinceLastAck:
          session.lastAckReceivedAtMs === null ? null : Date.now() - session.lastAckReceivedAtMs,
        ...(writtenOff.length > 0 ? { writtenOff } : {})
      }
    }
  )

  // Hold sends until the replacement renderer confirms its data dispatcher exists.
  ipcMain.removeAllListeners('pty:rendererDispatcherReady')
  ipcMain.on('pty:rendererDispatcherReady', (event) => {
    // Reconcile clears accounting; reject dying-window handshakes that could reset the new page.
    if (!isMainWindowPtyIpcEvent(event, mainWindow)) {
      return
    }
    // A handshake on an open gate reveals missed lifecycle reset; clear stale debt.
    if (session.rendererPtyDispatcherReady) {
      resetRendererDeliveryAccountingForLifecycleReset()
    }
    session.clearDispatcherReadyWatchdog()
    session.rendererPtyDispatcherReady = true
    session.pendingData.reactivateBlocked()
    session.schedulePendingDataFlush(0)
  })

  ipcMain.removeAllListeners('pty:setActiveRendererPty')
  ipcMain.on('pty:setActiveRendererPty', (_event, args: { id: string; active: boolean }) => {
    if (typeof args.id !== 'string' || !args.id) {
      return
    }
    // Active panes get scheduling priority; inactive ingestion, state and notifications continue.
    if (args.active) {
      if (activeRendererPtys.has(args.id)) {
        return
      }
      activeRendererPtys.add(args.id)
    } else if (!activeRendererPtys.delete(args.id)) {
      return
    }
    invalidatePendingPtyDrainPriority(args.id)
  })

  ipcMain.removeAllListeners('pty:setRendererPtyVisible')
  ipcMain.on('pty:setRendererPtyVisible', (_event, args: { id: string; visible: boolean }) => {
    if (typeof args.id !== 'string' || !args.id) {
      return
    }
    // Preserve hidden-at-production origin through batching even if visibility changes before flush.
    rendererVisibilityKnownPtys.add(args.id)
    if (args.visible) {
      visibleRendererPtys.add(args.id)
      closeStartupQueryAuthorityForPty(args.id)
    } else {
      visibleRendererPtys.delete(args.id)
    }
    session.syncPtyBackgroundedDelivery(args.id, 'visibility-report')
  })

  ipcMain.removeAllListeners('pty:setHiddenRendererPty')
  ipcMain.on('pty:setHiddenRendererPty', (_event, args: { id: string; hidden: boolean }) => {
    if (typeof args.id !== 'string' || !args.id) {
      return
    }
    mainDeliveryBreadcrumbs.record(args.hidden === true ? 'gate-mark' : 'gate-unmark', {
      id: redactPtyIdForDiagnostics(args.id)
    })
    const transition = session.transitionHiddenRendererPtyDeliveryState(
      args.id,
      args.hidden === true
    )
    if (args.hidden === true) {
      closeStartupQueryAuthorityForPty(args.id)
      // Newly hidden queued bytes can drop despite ACK starvation; reveal restores their model snapshot.
      const pending = session.pendingData.get(args.id)
      if (pending && transition.droppable) {
        session.pendingData.delete(args.id)
        session.updateProducerFlowControl(args.id)
        session.pendingOverflowMarkedPtys.delete(args.id)
        const drop = recordHiddenRendererPtyDataDrop(args.id, pending.data.length)
        if (drop.shouldEmitRestoreMarker) {
          sendModelRestoreNeededMarker(
            session,
            args.id,
            'hidden-drop',
            runtime?.getPtyOutputSequence(args.id),
            drop.hiddenDropEpisode
          )
        }
      }
      if (transition.policyChanged) {
        invalidatePendingPtyDrainPolicy(args.id)
      }
      session.syncPtyBackgroundedDelivery(args.id, 'gate-mark')
      return
    }
    if (transition.policyChanged) {
      invalidatePendingPtyDrainPolicy(args.id)
    }
    session.syncPtyBackgroundedDelivery(args.id, 'gate-unmark')
    // Reload/remount can replace the marker consumer; repeat on reveal rather than lose recovery.
    if (transition.droppedWhileHidden) {
      sendModelRestoreNeededMarker(
        session,
        args.id,
        'unhide',
        runtime?.getPtyOutputSequence(args.id),
        transition.hiddenDropEpisode
      )
    }
  })

  installTerminalViewAttributesIpc(session)

  ipcMain.removeAllListeners('pty:setPtyDeliveryInterest')
  ipcMain.on('pty:setPtyDeliveryInterest', (_event, args: { id: string; interested: boolean }) => {
    if (typeof args.id !== 'string' || !args.id) {
      return
    }
    // Raw-byte interests bypass hidden gating without changing daemon pacing during interest churn.
    const settings = session.getSettings?.()
    const wasDroppable = shouldDropHiddenRendererPtyData(args.id, settings)
    setRendererPtyDeliveryInterest(args.id, args.interested === true)
    if (wasDroppable !== shouldDropHiddenRendererPtyData(args.id, settings)) {
      invalidatePendingPtyDrainPolicy(args.id)
    }
  })

  ipcMain.removeAllListeners('pty:signal')
  ipcMain.on('pty:signal', (_event, args: { id: string; signal: string }) => {
    tryGetProviderForPty(args.id)
      ?.sendSignal(args.id, args.signal)
      .catch(() => {})
  })

  ipcMain.removeAllListeners('pty:clearBuffer')
  ipcMain.on('pty:clearBuffer', (_event, args: { id: string }) => {
    // Clear provider-side state so prompt repaint cannot reuse a stale cursor row.
    tryGetProviderForPty(args.id)
      ?.clearBuffer(args.id)
      .catch(() => {})
    runtime?.clearHeadlessTerminalBuffer(args.id).catch(() => {})
  })

  ipcMain.removeAllListeners('pty:resetInputModes')
  ipcMain.on('pty:resetInputModes', (_event, args: { id: string }) => {
    // Older daemon/relay rejection leaves its model modes until reattach.
    tryGetProviderForPty(args.id)
      ?.resetInputModes(args.id)
      .catch(() => {})
    runtime?.resetHeadlessTerminalInputModes(args.id).catch(() => {})
  })
}
