import { markClaudePtyExited } from '../../../claude-accounts/live-pty-gate'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import { isCurrentPtyExit, ptyOwnership } from './ownership-state'
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
import { providerSnapshotRequiredPtys } from '../delivery/visibility-state'
import type { PtyIpcSession } from '../session'

export function bindProviderListeners(session: PtyIpcSession): void {
  localDataUnsub?.()
  localExitUnsub?.()
  localBackgroundStreamUnsub?.()
  localWriteUnavailableUnsub?.()

  // Why: a daemon death takes down every session at once. The provider signals
  // each affected pane here so background panes remount + re-attach too, not
  // just the pane whose write happened to detect the dead endpoint (STA-2373).
  setLocalWriteUnavailableUnsub(
    localProvider.onWriteUnavailable?.((payload) => {
      if (
        session.mainWindow.isDestroyed() ||
        (typeof session.mainWindow.webContents.isDestroyed === 'function' &&
          session.mainWindow.webContents.isDestroyed())
      ) {
        return
      }
      session.mainWindow.webContents.send('pty:writeUnavailable', { id: payload.id })
    }) ?? null
  )

  // Daemon keep-tail thinning facts, in byte order with onData: markers flip transient-fact scan authority; a gap forces renderer restore from the snapshot.
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

  // Why: daemon providers lack configure().onData, so feed the runtime here or their tail buffer (terminal.read, agent-detection, mobile stream) stays empty.
  const isLocalProvider = localProvider instanceof LocalPtyProvider

  setLocalDataUnsub(
    localProvider.onData((payload) => {
      const rawLength = payload.sequenceChars ?? payload.data.length
      const outputSeq = isLocalProvider
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
      if (session.consumeSyntheticKillExit(payload.id)) {
        return
      }
      if (!isLocalProvider) {
        clearProviderPtyState(payload.id)
        ptyOwnership.delete(payload.id)
        markClaudePtyExited(payload.id)
        session.runtime?.onPtyExit(payload.id, payload.code, payload.incarnationId, {
          providerExitObserved: true,
          ...(payload.cause ? { cause: payload.cause } : {})
        })
      }
      // Why not the whole payload: the exit cause is a main-process fact for the
      // runtime's records; the renderer's pty:exit contract stays as it was.
      session.sendPtyExitToRenderer({
        id: payload.id,
        code: payload.code,
        ...(payload.incarnationId ? { incarnationId: payload.incarnationId } : {})
      })
    })
  )
}
