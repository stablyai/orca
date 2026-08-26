import { DaemonPtyDaemonRecovery } from './daemon-pty-daemon-recovery'
import { supportsMode2031UnsubscribeFact, type DaemonEvent } from './types'
import type { IPtyProvider } from '../providers/types'

export class DaemonPtyAdapter extends DaemonPtyDaemonRecovery implements IPtyProvider {
  protected setupEventRouting(): void {
    if (this.removeEventListener) {
      return
    }

    this.removeEventListener = this.client.onEvent((raw) => {
      const event = raw as DaemonEvent
      if (event.type !== 'event') {
        return
      }

      if (event.event === 'data') {
        this.markSessionDirty(event.sessionId)
        // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
        for (const listener of [...this.dataListeners]) {
          listener({
            id: event.sessionId,
            data: event.payload.data,
            ...((event.payload.rawLength ?? event.payload.sequenceChars) === undefined
              ? {}
              : { sequenceChars: event.payload.rawLength ?? event.payload.sequenceChars }),
            ...(event.payload.transformed ? { transformed: true } : {}),
            ...(event.payload.seq === undefined ? {} : { seq: event.payload.seq })
          })
        }
      } else if (event.event === 'sessionBackgroundMarker') {
        this.emitBackgroundStreamEvent({
          id: event.sessionId,
          kind: 'backgroundMarker',
          background: event.payload.background,
          ...(event.payload.scanSeedAnsi !== undefined
            ? { scanSeedAnsi: event.payload.scanSeedAnsi }
            : {}),
          ...(event.payload.mode2031PendingSubscribe
            ? { mode2031PendingSubscribe: true as const }
            : {})
        })
      } else if (event.event === 'dataGap') {
        this.emitBackgroundStreamEvent({
          id: event.sessionId,
          kind: 'dataGap',
          droppedChars: event.payload.droppedChars,
          ...(event.payload.sequenceChars === undefined
            ? {}
            : { sequenceChars: event.payload.sequenceChars })
        })
      } else if (event.event === 'transientFact') {
        // Why (#9993): a preserved pre-v29 daemon can retain a stale relay tracker. Its
        // unretractable subscribe is harmful; an unsubscribe is always safe to forward.
        if (
          event.payload.kind === '2031-subscribe' &&
          !supportsMode2031UnsubscribeFact(this.protocolVersion)
        ) {
          return
        }
        this.emitBackgroundStreamEvent({
          id: event.sessionId,
          kind: 'transientFact',
          fact: event.payload
        })
      } else if (event.event === 'exit') {
        const pendingOperations = new Set([
          ...(this.pendingSpawnOperationsBySessionId.get(event.sessionId) ?? []),
          ...this.pendingClaimSpawnOperations
        ])
        for (const operation of pendingOperations) {
          if (operation.ignoreNextExit) {
            operation.ignoreNextExit = false
            continue
          }
          const exits = operation.exitsBySessionId.get(event.sessionId) ?? []
          exits.push(
            event.payload.incarnationId ? { incarnationId: event.payload.incarnationId } : {}
          )
          operation.exitsBySessionId.set(event.sessionId, exits)
        }
        const currentIncarnationId = this.sessionIncarnations.get(event.sessionId)
        if (
          event.payload.incarnationId &&
          currentIncarnationId &&
          event.payload.incarnationId !== currentIncarnationId
        ) {
          return
        }
        this.activeSessionIds.delete(event.sessionId)
        this.clearSessionAwaitingDaemonRecovery(event.sessionId)
        this.dirtySessionVersions.delete(event.sessionId)
        this.pausedProducerSessionIds.delete(event.sessionId)
        this.producerResumesOwedOnReconnect.delete(event.sessionId)
        this.backgroundedSessionIds.delete(event.sessionId)
        if (!this.sleepRestoreSessionIds.has(event.sessionId)) {
          this.coldRestoreCache.delete(event.sessionId)
        }
        this.sessionsNeedingFullCheckpoint.delete(event.sessionId)
        this.sessionsNeedingLiveCheckpoint.delete(event.sessionId)
        this.sessionsNeedingContinuityCheckpoint.delete(event.sessionId)
        this.overlayDeadlineWarnedSessionIds.delete(event.sessionId)
        this.periodicDeadlineWarnedSessionIds.delete(event.sessionId)
        this.nonFinalAdmissionDeniedSessionIds.delete(event.sessionId)
        this.lastFullCheckpointAt.delete(event.sessionId)
        this.stopCheckpointTimerIfIdle()
        if (this.historyManager) {
          void this.historyManager
            .closeSession(event.sessionId, event.payload.code)
            .catch((err) => console.warn('[history] closeSession failed:', event.sessionId, err))
        }
        this.initialCwds.delete(event.sessionId)
        this.wslDistrosBySessionId.delete(event.sessionId)
        this.sessionIncarnations.delete(event.sessionId)
        // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
        for (const listener of [...this.exitListeners]) {
          listener({
            id: event.sessionId,
            code: event.payload.code,
            ...(event.payload.incarnationId ? { incarnationId: event.payload.incarnationId } : {}),
            ...(event.payload.cause ? { cause: event.payload.cause } : {})
          })
        }
      }
    })
  }

  async closeStartupQueryAuthority(id: string): Promise<number> {
    if (!this.supportsStartupIngress) {
      return 0
    }
    const result = await this.client.request<{ appliedSeq: number }>('closeStartupQueryAuthority', {
      sessionId: id
    })
    return result.appliedSeq
  }
}
