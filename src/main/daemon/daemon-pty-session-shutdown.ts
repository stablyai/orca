import type { ColdRestorePayload } from './cold-restore-payload-cache'
import { FinalCheckpointWaitExpiredError } from './daemon-pty-lifecycle-errors'
import { DaemonPtySessionSpawn } from './daemon-pty-session-spawn'
import { remainingDaemonRequestTimeoutMs } from './daemon-request-deadline'
import type { ColdRestoreInfo } from './history-reader'
import { normalizeWslColdRestoreCwd } from './wsl-cold-restore-cwd'
import { resolveSafePtyDefaultCwd } from '../providers/pty-default-cwd'
import type { PtyKillIntent } from '../../shared/pty-kill-sessions'
import {
  isPtyShutdownFenceUnavailable,
  type PtyShutdownResult
} from '../providers/pty-provider-contract'

const MAX_TOMBSTONES = 1000

export abstract class DaemonPtySessionShutdown extends DaemonPtySessionSpawn {
  async shutdown(
    id: string,
    opts: {
      immediate?: boolean
      keepHistory?: boolean
      deadlineMs?: number
      intent?: PtyKillIntent
      incarnationId?: string
    }
  ): Promise<void> {
    if (opts.keepHistory && this.disconnectOnlyPromise) {
      throw new Error('Cannot keep history after daemon disconnect has started')
    }
    const shutdown = this.withHistorySpawnLock(
      id,
      () => this.shutdownWithHistoryLock(id, opts) as Promise<void>
    )
    if (!opts.keepHistory) {
      await shutdown
      return
    }
    this.keepHistoryShutdowns.add(shutdown)
    try {
      await shutdown
    } finally {
      this.keepHistoryShutdowns.delete(shutdown)
    }
  }

  async shutdownWithOutcome(
    id: string,
    opts: {
      immediate?: boolean
      keepHistory?: boolean
      deadlineMs?: number
      intent?: PtyKillIntent
      incarnationId?: string
    }
  ): Promise<PtyShutdownResult | void> {
    if (opts.keepHistory && this.disconnectOnlyPromise) {
      throw new Error('Cannot keep history after daemon disconnect has started')
    }
    const shutdown = this.withHistorySpawnLock(
      id,
      () => this.shutdownWithHistoryLock(id, opts) as Promise<PtyShutdownResult | void>
    )
    if (!opts.keepHistory) {
      return await shutdown
    }
    const tracked = shutdown.then(
      () => undefined,
      () => undefined
    )
    this.keepHistoryShutdowns.add(tracked)
    try {
      return await shutdown
    } finally {
      this.keepHistoryShutdowns.delete(tracked)
    }
  }

  protected async shutdownWithHistoryLock(
    id: string,
    opts: {
      immediate?: boolean
      keepHistory?: boolean
      deadlineMs?: number
      intent?: PtyKillIntent
      incarnationId?: string
    }
  ): Promise<PtyShutdownResult | void> {
    await this.ensureConnected(opts.deadlineMs)
    let coldRestore: ColdRestorePayload | null = null
    let suspendHistory = false
    if (opts.keepHistory) {
      const committed = await this.runExclusiveCheckpoint(
        async () => {
          await this.checkpointSessions([id], { final: true, teardown: true })
        },
        { callerDeadlineMs: opts.deadlineMs }
      )
      if (!committed) {
        throw new FinalCheckpointWaitExpiredError(id)
      }
      const wslDistro = this.wslDistrosBySessionId.get(id)
      const detection = await this.historyReader?.detectColdRestoreState(id, { wslDistro })
      const detected = detection?.status === 'restored' ? detection.restoreInfo : null
      const restoreInfo = detected
        ? {
            ...detected,
            cwd:
              normalizeWslColdRestoreCwd({
                recoveredCwd: detected.cwd,
                requestedCwd: this.initialCwds.get(id) ?? resolveSafePtyDefaultCwd(),
                wslDistro
              }) ?? ''
          }
        : null
      coldRestore = restoreInfo ? this.buildColdRestorePayload(restoreInfo) : null
      suspendHistory =
        !coldRestore &&
        (detection?.status === 'unreadable' ||
          (detection?.status === 'restored' && detection.hasUnreadableRecovery))
      // Why: suspend before kill so onExit cannot mark sleep history clean; fenced refusals reopen it.
      if (coldRestore || suspendHistory) {
        this.historyManager?.suspendSession(id)
      }
    }
    const result = await this.client.request(
      'kill',
      {
        sessionId: id,
        immediate: opts.immediate ?? false,
        intent: opts.intent,
        incarnationId: opts.incarnationId
      },
      remainingDaemonRequestTimeoutMs(opts.deadlineMs)
    )
    if (isPtyShutdownFenceUnavailable(result)) {
      if (opts.keepHistory && (coldRestore || suspendHistory)) {
        this.historyManager?.reopenSession(id)
      }
      return result as PtyShutdownResult
    }
    if (coldRestore) {
      this.coldRestoreCache.set(id, coldRestore)
      this.sleepRestoreSessionIds.add(id)
    }
    this.activeSessionIds.delete(id)
    this.clearSessionAwaitingDaemonRecovery(id)
    this.dirtySessionVersions.delete(id)
    if (!opts.keepHistory) {
      this.coldRestoreCache.delete(id)
      this.sleepRestoreSessionIds.delete(id)
    }
    this.sessionsNeedingFullCheckpoint.delete(id)
    this.sessionsNeedingLiveCheckpoint.delete(id)
    this.sessionsNeedingContinuityCheckpoint.delete(id)
    this.overlayDeadlineWarnedSessionIds.delete(id)
    this.periodicDeadlineWarnedSessionIds.delete(id)
    this.nonFinalAdmissionDeniedSessionIds.delete(id)
    this.lastFullCheckpointAt.delete(id)
    this.stopCheckpointTimerIfIdle()
    this.initialCwds.delete(id)
    this.wslDistrosBySessionId.delete(id)
    if (this.historyManager && !opts.keepHistory) {
      await this.historyManager
        .removeSession(id)
        .catch((err) => console.warn('[history] removeSession failed:', id, err))
    }
    if (!opts.keepHistory) {
      this.killedSessionTombstones.delete(id)
      this.killedSessionTombstones.set(id, Date.now())
      if (this.killedSessionTombstones.size > MAX_TOMBSTONES) {
        const oldest = this.killedSessionTombstones.keys().next().value as string | undefined
        if (oldest !== undefined) {
          this.killedSessionTombstones.delete(oldest)
        }
      }
    }
    return result as PtyShutdownResult | void
  }

  ackColdRestore(sessionId: string): void {
    this.coldRestoreCache.delete(sessionId)
    this.sleepRestoreSessionIds.delete(sessionId)
  }
  clearTombstone(sessionId: string): void {
    this.killedSessionTombstones.delete(sessionId)
  }

  protected buildColdRestorePayload(restoreInfo: ColdRestoreInfo): ColdRestorePayload | null {
    const scrollback = restoreInfo.modes.alternateScreen
      ? restoreInfo.scrollbackAnsi || restoreInfo.snapshotAnsi || null
      : restoreInfo.rehydrateSequences + restoreInfo.snapshotAnsi
    if (!scrollback) {
      return null
    }
    return {
      scrollback,
      cwd: restoreInfo.cwd,
      cols: restoreInfo.cols,
      rows: restoreInfo.rows,
      oscLinks: restoreInfo.oscLinks,
      ...(restoreInfo.lastTitle ? { lastTitle: restoreInfo.lastTitle } : {})
    }
  }
}
