import { isCurrentPtyExit, ptyOwnership } from './ownership-state'
import { wslBridgePtyPresence } from '../../../agent-hooks/wsl-relay/wsl-bridge-pty-presence'
import {
  localBackgroundStreamUnsub,
  localDataUnsub,
  localExitUnsub,
  localWriteUnavailableUnsub,
  setLocalBackgroundStreamUnsub,
  setLocalDataUnsub,
  setLocalExitUnsub,
  setLocalWriteUnavailableUnsub
} from './listener-lifecycle'
import { localProvider } from './registry'
import { clearProviderPtyState } from './state-cleanup'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { providerSnapshotRequiredPtys, visibleRendererPtys } from '../delivery/visibility-state'
import { markPtyEscapeBoundaryUnknown } from '../delivery/pty-escape-boundary'
import { discardPendingPtyDataAcrossGap } from '../delivery/accept'
import type { PtyIpcSession } from '../session'
import { publishPtyEndpointLoss } from '../../../runtime/terminal/pty-endpoint-loss-signal'
import { codexAccountRestartStops } from '../account-restart/codex-account-restart-stops'

export function bindProviderListeners(session: PtyIpcSession): void {
  localDataUnsub?.()
  localExitUnsub?.()
  localBackgroundStreamUnsub?.()
  localWriteUnavailableUnsub?.()

  // Daemon death invalidates every session; notify background panes too so they can remount (STA-2373).
  setLocalWriteUnavailableUnsub(
    localProvider.onWriteUnavailable?.((payload) => {
      // Before the window check: a headless host has no window, only remote streams.
      publishPtyEndpointLoss(payload.id)
      session.runtime?.notePtyEndpointLoss(payload.id)
      if (
        !session.mainWindow ||
        session.mainWindow.isDestroyed() ||
        (typeof session.mainWindow.webContents.isDestroyed === 'function' &&
          session.mainWindow.webContents.isDestroyed())
      ) {
        return
      }
      session.mainWindow.webContents.send('pty:writeUnavailable', { id: payload.id })
    }) ?? null
  )

  // Apply thinning facts in stream order; gaps require snapshot restore and change transient-scan authority.
  setLocalBackgroundStreamUnsub(
    localProvider.onBackgroundStreamEvent?.((payload) => {
      if (payload.kind === 'backgroundMarker') {
        session.runtime?.setPtyTransientFactDelegation(
          payload.id,
          payload.background,
          payload.scanSeedAnsi,
          payload.mode2031PendingSubscribe
        )
        return
      }
      if (payload.kind === 'dataGap') {
        providerSnapshotRequiredPtys.add(payload.id)
        // The kept tail may start inside an escape whose head the provider dropped.
        markPtyEscapeBoundaryUnknown(payload.id)
        discardPendingPtyDataAcrossGap(session, payload.id)
        session.runtime?.notePtyDataGap(payload.id, payload.sequenceChars ?? payload.droppedChars)
        session.sendModelRestoreNeededMarker(
          payload.id,
          'hidden-drop',
          session.runtime?.getPtyOutputSequence(payload.id)
        )
        return
      }
      session.runtime?.emitDaemonPtyTransientFact(payload.id, payload.fact)
    }) ?? null
  )

  // Feed the runtime unless the emitting provider already did via configure().
  setLocalDataUnsub(
    localProvider.onData((payload) => {
      const rawLength = payload.sequenceChars ?? payload.data.length
      const outputSeq = payload.runtimeFed
        ? session.runtime?.getPtyOutputSequence(payload.id)
        : session.runtime?.onPtyData(
            payload.id,
            payload.data,
            Date.now(),
            rawLength,
            payload.transformed
          )
      session.acceptPtyDataForRenderer(payload, outputSeq)
    })
  )
  setLocalExitUnsub(
    localProvider.onExit((payload) => {
      if (!isCurrentPtyExit(payload)) {
        return
      }
      // Its distro's hook relay may idle out once no bridge terminal remains.
      wslBridgePtyPresence.noteExited(payload.id)
      const syntheticExit = session.consumeSyntheticKillExit(payload.id, payload.incarnationId)
      // Classify before any consumer: an account-restart stop delivers one logical exit per incarnation.
      const accountRestartExit = codexAccountRestartStops.classifyExit(
        payload.id,
        payload.incarnationId,
        payload.hostLost ? 'host-loss' : 'stream'
      )
      if (accountRestartExit === 'duplicate') {
        return
      }
      const isAccountRestartExit = accountRestartExit !== 'ordinary'
      // Daemon restart replaces processes while their panes survive; so does an account-restart stop.
      const settleRestartStop =
        payload.replacedByRestart || isAccountRestartExit
          ? session.runtime?.intentionalPtyStops?.mark(
              payload.id,
              'replaced',
              payload.incarnationId ?? null
            )
          : undefined
      try {
        if (!payload.runtimeFed) {
          const viewShown = ORCA_LAYOUT_OWNER_IS_MAIN && visibleRendererPtys.has(payload.id)
          clearProviderPtyState(payload.id, { exitProven: true })
          ptyOwnership.delete(payload.id)
          if (syntheticExit) {
            session.runtime?.markPtyStopRequested(payload.id)
          }
          // An attach miss already told runtime about this restart exit; only the renderer is owed it.
          if (accountRestartExit !== 'restart-renderer-only') {
            session.runtime?.onPtyExit(payload.id, payload.code, payload.incarnationId, {
              providerExitObserved: true,
              ...(viewShown ? { viewShown } : {}),
              ...(payload.cause ? { cause: payload.cause } : {}),
              ...(payload.hostLost ? { hostLost: true } : {}),
              // The pane's normal resume brings this conversation back, so an active Dispatch waits for it.
              ...(isAccountRestartExit ? { paneRespawning: true } : {})
            })
          }
        }
        // Control replies may overtake stream data; physical exit must still retire late output.
        if (syntheticExit) {
          return
        }
        // Exit cause belongs to runtime records; preserve the renderer event contract.
        session.sendPtyExitToRenderer({
          id: payload.id,
          code: payload.code,
          ...(payload.incarnationId ? { incarnationId: payload.incarnationId } : {})
        })
      } finally {
        settleRestartStop?.(true)
      }
    })
  )
}
