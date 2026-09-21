import { getPtyIpc } from '../../pty-host-bindings'
import type {
  PtyDeliveryWriteOff,
  PtyRendererDeliveryHealthReply,
  PtyRendererDeliveryStateReport
} from '../../../../shared/pty-renderer-delivery-health'
import { redactPtyIdForDiagnostics } from '../../../../shared/pty-delivery-diagnostics'
import { setTerminalViewAttributes } from '../../../runtime/terminal-view-attribute-store'
import { validateTerminalViewAttributes } from '../../../../shared/terminal-view-attributes'
import {
  recordHiddenRendererPtyDataDrop,
  setRendererPtyDeliveryInterest,
  shouldDropHiddenRendererPtyData
} from '../../pty-hidden-delivery-gate'
import { tryGetProviderForPty, closeStartupQueryAuthorityForPty } from '../provider/registry'
import {
  activeRendererPtys,
  deliveredHiddenRendererResizeOutputPtys,
  invalidatePendingPtyDrainPolicy,
  invalidatePendingPtyDrainPriority,
  pendingHiddenRendererResizeOutputPtys,
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
import type { PtyIpcSession } from '../session'

export function installPtyResizeVisibilityIpc(session: PtyIpcSession): void {
  const ipcMain = getPtyIpc()
  const { runtime, mainWindow } = session

  // Why: resize is fire-and-forget — ipcMain.on (not .handle) halves IPC traffic by skipping the empty acknowledgement reply.
  ipcMain.removeAllListeners('pty:resize')
  ipcMain.on('pty:resize', (_event, args: { id: string; cols: number; rows: number }) => {
    // Why: after a desktop-fit override change the renderer's safeFit cascade re-measures ALL panes (background ones at full width), so suppress every pty:resize in this window to avoid corrupting PTY dimensions.
    if (runtime?.isResizeSuppressed()) {
      return
    }
    // Why: presence-lock defense-in-depth — while a phone or remote-desktop viewer drives the width, host-side resizes must not reach the PTY or its alt-screen grid garbles; load-bearing because the renderer mirror lags one IPC hop. See docs/mobile-presence-lock.md.
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
    const markedHiddenResizeOutput = session.rendererPtyIsKnownHidden(args.id)
    if (markedHiddenResizeOutput) {
      // Why: alt-screen TUIs repaint on SIGWINCH; a hidden repaint read after switch-back must not masquerade as live output and overwrite the correctly-sized screen.
      pendingHiddenRendererResizeOutputPtys.add(args.id)
      deliveredHiddenRendererResizeOutputPtys.delete(args.id)
    } else if (visibleRendererPtys.has(args.id)) {
      // Why: after the stale hidden-resize repaint is observed, the renderer's visible resize pulse owns the next repaint.
      session.clearDeliveredHiddenRendererResizeOutput(args.id)
    }
    try {
      provider.resize(args.id, args.cols, args.rows)
    } catch {
      if (markedHiddenResizeOutput) {
        pendingHiddenRendererResizeOutputPtys.delete(args.id)
      }
      return
    }
    ptySizes.set(args.id, { cols: args.cols, rows: args.rows })
    runtime?.onExternalPtyResize(args.id, args.cols, args.rows)
  })

  // Why: pty:reportGeometry is a measurement-only sibling of pty:resize — it refreshes the restore-target cache (never resizes) so mobile-fit hold learns real desktop dims even while resize is blocked. See docs/mobile-fit-hold.md.
  ipcMain.removeAllListeners('pty:reportGeometry')
  ipcMain.on('pty:reportGeometry', (_event, args: { id: string; cols: number; rows: number }) => {
    runtime?.recordRendererGeometry(args.id, args.cols, args.rows)
  })

  // Why: fire-and-forget — clears the DaemonPtyAdapter's sticky cold-restore cache after the renderer consumed it; no-op for non-daemon providers.
  ipcMain.removeAllListeners('pty:ackColdRestore')
  ipcMain.on('pty:ackColdRestore', (_event, args: { id: string }) => {
    const provider = tryGetProviderForPty(args.id)
    if (provider && 'ackColdRestore' in provider && typeof provider.ackColdRestore === 'function') {
      provider.ackColdRestore(args.id)
    }
  })

  // Why: renderer ACKs bound main→renderer delivery without stopping PTY ingestion — agent/status consumers still see every chunk via the provider/runtime path.
  ipcMain.removeAllListeners('pty:ackData')
  ipcMain.on(
    'pty:ackData',
    (_event, args: { id: string; charCount?: number; processedChars?: number }) => {
      session.lastAckReceivedAtMs = Date.now()
      // Why: a live ACK channel means a future unanswered probe is a fresh diagnostic event, not a continuation of the last silent streak.
      session.deliveryResyncUnansweredWarnLogged = false
      let acknowledged = 0
      if (typeof args.processedChars === 'number' && Number.isFinite(args.processedChars)) {
        acknowledged = applyCumulativeAck(session, args.id, Math.max(0, args.processedChars))
      } else {
        // Why: tolerate legacy per-chunk delta payloads — dev hot-reload can pair an old renderer with a new main.
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
      // Why max-merge: the renderer's cumulative totals are authoritative for what it processed, draining exactly the in-flight debt from lost ACKs.
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

  // Why invoke + renderer-initiated: the field wedge (v1.4.121-rc.0) kills every main→renderer push channel while invoke survives, so the resync rides here plus a write-off lane.
  ipcMain.removeHandler('pty:reportRendererDeliveryState')
  ipcMain.handle(
    'pty:reportRendererDeliveryState',
    (_event, args: PtyRendererDeliveryStateReport): PtyRendererDeliveryHealthReply => {
      // Extra repair lane for the lost-ACK variant: identical max-merge to the resync response, so a heal is only reached when merging cannot drain.
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
      // Why the main-side ACK-silence check: requiring main to have also seen no ACK stops a buggy/foreign caller from writing off live delivery.
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

  // Why: renderer signals its pty:data listener is live; until then sends are held so boot-window bytes can't drop into a listener-less page and pin the gate.
  ipcMain.removeAllListeners('pty:rendererDispatcherReady')
  ipcMain.on('pty:rendererDispatcherReady', (event) => {
    // Why: the reconcile below destructively clears delivery accounting, so a straggler handshake from a dying window must not reset the new window.
    if (!isMainWindowPtyIpcEvent(event, mainWindow, mainWindow.webContents)) {
      return
    }
    // Why: a handshake while the gate is already open means a page load whose lifecycle reset was missed; clear the dead page's stale accounting so it can't permanently gate survivors.
    if (session.rendererPtyDispatcherReady) {
      resetRendererDeliveryAccountingForLifecycleReset()
    }
    // Why: real handshake landed — cancel the self-heal watchdog so it can't later force-open the gate.
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
    // Why: renderer scheduling hint only — active panes just get first chance at the bounded output reserve; reads/state/notifications continue for inactive terminals.
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
    // Why: data produced while no renderer can see this PTY must keep that origin through batching, even if the user switches back before the flush lands.
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
      // Why: drop bytes queued for a newly hidden PTY instead of holding them under ACK starvation; reveal restores from the snapshot.
      const pending = session.pendingData.get(args.id)
      if (pending && transition.droppable) {
        session.pendingData.delete(args.id)
        if (pending.projectionAdmissionIds) {
          session.sshOutputIntake?.transferProjections(
            pending.projectionAdmissionIds,
            'hidden-drop'
          )
        }
        session.updateProducerFlowControl(args.id)
        session.pendingOverflowMarkedPtys.delete(args.id)
        const drop = recordHiddenRendererPtyDataDrop(args.id, pending.data.length)
        if (drop.shouldEmitRestoreMarker) {
          sendModelRestoreNeededMarker(
            session,
            args.id,
            'hidden-drop',
            runtime?.getPtyOutputSequence(args.id)
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
    // Why: a reload/remount may have replaced the view that latched restore-needed, so re-emit on unhide; a redundant replay is cheap/idempotent, a missed restore corrupts the pane.
    if (transition.droppedWhileHidden) {
      sendModelRestoreNeededMarker(
        session,
        args.id,
        'unhide',
        runtime?.getPtyOutputSequence(args.id)
      )
    }
  })

  ipcMain.removeAllListeners('pty:terminalViewAttributes')
  ipcMain.on('pty:terminalViewAttributes', (_event, args: unknown) => {
    // Why validate-or-drop: a malformed palette gives a wrong color reply that breaks TUI theme detection worse than the silent-until-first-push default.
    const attributes = validateTerminalViewAttributes(args)
    if (attributes) {
      setTerminalViewAttributes(attributes)
    }
  })

  ipcMain.removeAllListeners('pty:setPtyDeliveryInterest')
  ipcMain.on('pty:setPtyDeliveryInterest', (_event, args: { id: string; interested: boolean }) => {
    if (typeof args.id !== 'string' || !args.id) {
      return
    }
    // Why: any delivery interest suppresses the hidden-delivery gate (raw-byte consumers keep receiving while hidden); not synced to the daemon pacer so interest churn can't un-pace a flood.
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
    // Why: clear PTY-side state (ConPTY/daemon/SSH buffer) so the next prompt repaint doesn't land at a stale cursor row.
    tryGetProviderForPty(args.id)
      ?.clearBuffer(args.id)
      .catch(() => {})
    runtime?.clearHeadlessTerminalBuffer(args.id).catch(() => {})
  })
}
