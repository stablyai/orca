import { markClaudePtyExited } from '../../../claude-accounts/live-pty-gate'
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
import { registeredPtyProviders } from './registry'
import type { IPtyProvider } from '../../../providers/types'
import { clearProviderPtyState } from './state-cleanup'
import { providerSnapshotRequiredPtys } from '../delivery/visibility-state'
import type { PtyIpcSession } from '../session'

function subscribeLocalProviders(subscribe: (provider: IPtyProvider) => (() => void) | undefined) {
  const cleanups = registeredPtyProviders()
    .filter(({ connectionId }) => connectionId === null)
    .map(({ provider }) => subscribe(provider))
  return () => cleanups.forEach((cleanup) => cleanup?.())
}

export function bindProviderListeners(
  session: Pick<
    PtyIpcSession,
    | 'mainWindow'
    | 'runtime'
    | 'sendModelRestoreNeededMarker'
    | 'acceptPtyDataForRenderer'
    | 'consumeSyntheticKillExit'
    | 'sendPtyExitToRenderer'
  >
): void {
  localDataUnsub?.()
  localExitUnsub?.()
  localBackgroundStreamUnsub?.()
  localWriteUnavailableUnsub?.()

  // Why: a daemon death takes down every session at once. The provider signals
  // each affected pane here so background panes remount + re-attach too, not
  // just the pane whose write happened to detect the dead endpoint (STA-2373).
  setLocalWriteUnavailableUnsub(
    subscribeLocalProviders((provider) =>
      provider.onWriteUnavailable?.((payload) => {
        if (
          !session.mainWindow ||
          session.mainWindow.isDestroyed() ||
          (typeof session.mainWindow.webContents.isDestroyed === 'function' &&
            session.mainWindow.webContents.isDestroyed())
        ) {
          return
        }
        session.mainWindow.webContents.send('pty:writeUnavailable', { id: payload.id })
      })
    )
  )

  // Daemon keep-tail thinning facts, in byte order with onData: markers flip transient-fact scan authority; a gap forces renderer restore from the snapshot.
  setLocalBackgroundStreamUnsub(
    subscribeLocalProviders((provider) =>
      provider.onBackgroundStreamEvent?.((payload) => {
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
      })
    )
  )

  // Why: daemon providers lack configure().onData, so feed the runtime here or their tail buffer (terminal.read, agent-detection, mobile stream) stays empty.

  setLocalDataUnsub(
    subscribeLocalProviders((provider) =>
      provider.onData((payload) => {
        const rawLength = payload.sequenceChars ?? payload.data.length
        const outputSeq = session.runtime?.onPtyData(
          payload.id,
          payload.data,
          Date.now(),
          rawLength,
          payload.transformed
        )
        session.acceptPtyDataForRenderer(payload, outputSeq)
      })
    )
  )
  setLocalExitUnsub(
    subscribeLocalProviders((provider) =>
      provider.onExit((payload) => {
        if (!isCurrentPtyExit(payload)) {
          return
        }
        const syntheticExit = session.consumeSyntheticKillExit(payload.id, payload.incarnationId)
        {
          clearProviderPtyState(payload.id)
          ptyOwnership.delete(payload.id)
          markClaudePtyExited(payload.id)
          if (syntheticExit) {
            session.runtime?.markPtyStopRequested(payload.id)
          }
          session.runtime?.onPtyExit(payload.id, payload.code, payload.incarnationId, {
            providerExitObserved: true,
            ...(payload.cause ? { cause: payload.cause } : {})
          })
        }
        // The control reply can overtake stream data; the physical exit must retire that late output.
        if (syntheticExit) {
          return
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
  )
}
