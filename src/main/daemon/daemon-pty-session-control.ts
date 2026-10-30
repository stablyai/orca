import { coldRestorePayloadFromInfo, type ColdRestorePayload } from './cold-restore-payload-cache'
import { isUnknownRequestTypeError } from './daemon-endpoint-errors'
import { GET_SIZE_PROTOCOL_VERSION } from './daemon-protocol-version'
import { readDaemonAppliedPtySize, type DaemonAppliedPtySize } from './daemon-pty-applied-size'
import { FinalCheckpointWaitExpiredError } from './daemon-pty-lifecycle-errors'
import { DaemonPtySessionInput } from './daemon-pty-session-input'
import { remainingDaemonRequestTimeoutMs } from './daemon-request-deadline'
import { readDaemonLiveSleepCwd } from './daemon-live-sleep-cwd'
import type { ColdRestoreInfo } from './history-reader'
import { normalizeWslColdRestoreCwd } from './wsl-cold-restore-cwd'
import { logSleepFolderRead, readDaemonWslSleepCwdWithFacts } from './daemon-wsl-sleep-cwd'
import * as unlistedSession from './daemon-unlisted-session'
import { SessionNotFoundError, type ListSessionsResult } from './types'
import { resolveSafePtyDefaultCwd } from '../providers/pty-default-cwd'
import type { PtySpawnResult } from '../providers/pty-provider-contract'

export const LIVENESS_PROBE_TIMEOUT_MS = 2_000

const MAX_TOMBSTONES = 1000
// A busy daemon must not eat the final checkpoint's share of the Sleep deadline.

export abstract class DaemonPtySessionControl extends DaemonPtySessionInput {
  protected abstract adoptListedSessionForSleep(
    sessionId: string,
    deadlineMs?: number
  ): Promise<void>

  async attach(id: string): Promise<Pick<PtySpawnResult, 'providerSequence' | 'lastTitle'> | void> {
    await this.ensureConnected()
    if (!this.canDelegateBackgroundToDaemon) {
      this.setPtyBackgrounded(id, false)
    }

    // Attach at the proven live size; default geometry could resize an agent TUI or accidentally create a shell.
    // Preserve transport errors: treating lost contact as absence could duplicate or retire a live owner.
    const size = await this.readAppliedSize(id, 'preserve')
    if (!size) {
      throw new SessionNotFoundError(id)
    }
    const result = await this.spawn({
      sessionId: id,
      cols: size.cols,
      rows: size.rows,
      attachOnly: true
    })
    if (result.exitedBeforeSpawnReply) {
      throw new SessionNotFoundError(id)
    }
    // A restarted runtime has never seen the surviving session's title.
    return result.providerSequence || result.lastTitle
      ? {
          ...(result.providerSequence ? { providerSequence: result.providerSequence } : {}),
          ...(result.lastTitle ? { lastTitle: result.lastTitle } : {})
        }
      : undefined
  }

  hasPty(id: string): boolean {
    return this.activeSessionIds.has(id)
  }

  /** Use the same saved-history probe as spawn. */
  hasRestorableHistory(id: string): boolean {
    return this.historyReader?.hasRestorableHistory(id) ?? false
  }

  async probePtyLiveness(id: string): Promise<boolean | null> {
    try {
      if (!this.getSizeUnsupported && this.protocolVersion >= GET_SIZE_PROTOCOL_VERSION) {
        try {
          const result = await this.client.request<{ size: { cols: number; rows: number } | null }>(
            'getSize',
            { sessionId: id },
            LIVENESS_PROBE_TIMEOUT_MS
          )
          return result.size !== null
        } catch (error) {
          // getSize shipped without a protocol bump; remember rejection instead of trusting the version alone.
          if (!isUnknownRequestTypeError(error)) {
            throw error
          }
          this.getSizeUnsupported = true
        }
      }
      // Legacy listSessions can prove absence; request it directly to avoid publishing inventory audit observations.
      const { sessions } = await this.client.request<ListSessionsResult>(
        'listSessions',
        undefined,
        LIVENESS_PROBE_TIMEOUT_MS
      )
      return sessions.some((session) => session.sessionId === id && session.isAlive)
    } catch {
      return null
    }
  }

  /** Whether this daemon lists the session at all, alive or not; null when it can't answer. */
  listsSession(id: string): Promise<boolean | null> {
    return unlistedSession.readDaemonSessionListing(this.client, id, LIVENESS_PROBE_TIMEOUT_MS)
  }

  /** The daemons that share this history dir and can answer for it; a router widens this. */
  private listingDaemons: () => readonly unlistedSession.SessionListingDaemon[] = () => [this]

  shareSessionListingWith(daemons: () => readonly unlistedSession.SessionListingDaemon[]): void {
    this.listingDaemons = daemons
  }

  async shutdown(
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ): Promise<void> {
    if (opts.keepHistory && this.disconnectOnlyPromise) {
      throw new Error('Cannot keep history after daemon disconnect has started')
    }
    if (!opts.keepHistory) {
      await this.withHistorySpawnLock(id, () => this.shutdownWithHistoryLock(id, opts))
      return
    }
    const shutdown = Promise.resolve().then(async () => {
      // Outside the spawn lock, which adopting the session's history takes itself.
      await this.ensureConnected(opts.deadlineMs)
      await this.adoptListedSessionForSleep(id, opts.deadlineMs).catch(() => {})
      await this.withHistorySpawnLock(id, () => this.shutdownWithHistoryLock(id, opts))
    })
    this.keepHistoryShutdowns.add(shutdown)
    try {
      await shutdown
    } finally {
      this.keepHistoryShutdowns.delete(shutdown)
    }
  }

  protected async shutdownWithHistoryLock(
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ): Promise<void> {
    // Connect lazily, sharing one deadline with checkpoint waits and kill; durable writes themselves remain unbounded.
    await this.ensureConnected(opts.deadlineMs)
    // Sleep may precede the first periodic checkpoint; persist the screen before killing.
    if (opts.keepHistory) {
      const sleepWslDistro = this.wslDistrosBySessionId.get(id)
      const sleepPaneKey = this.wslPaneKeysBySessionId.get(id)
      const live = this.activeSessionIds.has(id)
      const startedAt = Date.now()
      const read =
        sleepWslDistro && sleepPaneKey
          ? // A live pane's own wsl.exe keeps its distro running.
            await readDaemonWslSleepCwdWithFacts(
              { paneKey: sleepPaneKey, wslDistro: sleepWslDistro, live },
              opts.deadlineMs
            )
          : { cwd: live ? await readDaemonLiveSleepCwd(this.client, id, opts.deadlineMs) : null }
      const sleepCwd = read.cwd
      // Device runs need to see why a WSL pane woke at its spawn folder (awin 5e).
      const sleepFolder = {
        wslDistro: sleepWslDistro,
        paneKey: sleepPaneKey,
        live,
        elapsedMs: Date.now() - startedAt
      }
      logSleepFolderRead(id, read, sleepFolder)
      const committed = await this.runExclusiveCheckpoint(
        async () => {
          // Set inside: a caller past its deadline leaves this checkpoint running without it.
          if (sleepCwd) {
            this.probedShellCwds.set(id, sleepCwd)
          }
          try {
            await this.checkpointSessions([id], { final: true, teardown: true })
          } finally {
            this.probedShellCwds.delete(id)
          }
        },
        { callerDeadlineMs: opts.deadlineMs }
      )
      // Caller timeout leaves the checkpoint running; preserve the live PTY until recovery data is verified.
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
      const coldRestore = restoreInfo ? this.buildColdRestorePayload(restoreInfo) : null
      if (coldRestore) {
        this.coldRestoreCache.set(id, coldRestore)
        if (this.coldRestoreCache.has(id)) {
          this.sleepRestoreSessionIds.add(id)
        }
        // Intentional sleep keeps the final checkpoint authoritative; physical exit must not mark history clean.
        this.historyManager?.suspendSession(id)
      } else if (
        detection?.status === 'unreadable' ||
        (detection?.status === 'restored' && detection.hasUnreadableRecovery)
      ) {
        this.historyManager?.suspendSession(id)
      }
    }
    try {
      await this.client.request(
        'kill',
        { sessionId: id, immediate: opts.immediate ?? false },
        remainingDaemonRequestTimeoutMs(opts.deadlineMs)
      )
    } catch (error) {
      // Gone is known for a session this adapter lost, or (after a relaunch forgot that) one whose
      // history is unended and that no daemon sharing the history dir may still run.
      if (
        opts.keepHistory ||
        !(error instanceof SessionNotFoundError) ||
        !(
          this.hostLossSessionIds.has(id) ||
          (await unlistedSession.isUnlistedLostSession(
            id,
            this.historyReader,
            this.runtimeDir,
            this.listingDaemons()
          ))
        )
      ) {
        throw error
      }
    }
    await this.completeShutdownWithHistoryLock(id, opts)
  }

  /** Complete an explicit close without issuing another kill; the caller holds the spawn/history lock. */
  protected async completeShutdownWithHistoryLock(
    id: string,
    opts: { keepHistory?: boolean }
  ): Promise<void> {
    this.ptyInventory.retire(id, this.ptyInventory.currentIncarnation(id))
    this.activeSessionIds.delete(id)
    this.hostLossSessionIds.delete(id)
    this.clearSessionAwaitingDaemonRecovery(id)
    this.dirtySessionVersions.delete(id)
    if (!opts.keepHistory) {
      this.coldRestoreCache.delete(id)
      this.sleepRestoreSessionIds.delete(id)
    }
    // Explicit close takes no final checkpoint, so clear its pending full-checkpoint state here.
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
    this.wslPaneKeysBySessionId.delete(id)
    // Explicit close removes history; sleep preserves it for wake-time recovery.
    if (this.historyManager && !opts.keepHistory) {
      await this.historyManager
        .removeSession(id)
        .catch((err) => console.warn('[history] removeSession failed:', id, err))
    }

    // Tombstone explicit kills, but allow sleep sessions to reattach on wake.
    if (!opts.keepHistory) {
      this.killedSessionTombstones.delete(id)
      this.killedSessionTombstones.set(id, Date.now())
      if (this.killedSessionTombstones.size > MAX_TOMBSTONES) {
        const oldest = this.killedSessionTombstones.keys().next().value
        if (oldest) {
          this.killedSessionTombstones.delete(oldest)
        }
      }
    }
  }

  ackColdRestore(sessionId: string): void {
    this.coldRestoreCache.delete(sessionId)
    this.sleepRestoreSessionIds.delete(sessionId)
  }

  clearTombstone(sessionId: string): void {
    this.killedSessionTombstones.delete(sessionId)
  }

  protected buildColdRestorePayload(restoreInfo: ColdRestoreInfo): ColdRestorePayload | null {
    return coldRestorePayloadFromInfo(restoreInfo)
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    await this.client.request('signal', { sessionId: id, signal })
  }

  async getCwd(id: string): Promise<string> {
    try {
      const result = await this.client.request<{ cwd: string | null }>('getCwd', {
        sessionId: id
      })
      return result.cwd ?? ''
    } catch {
      return ''
    }
  }

  async getInitialCwd(id: string): Promise<string> {
    return this.initialCwds.get(id) ?? ''
  }

  // Resize notifications can be dropped; report applied dimensions so the renderer can repair drift.
  async getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    return await this.readAppliedSize(id, 'suppress')
  }

  private async readAppliedSize(
    id: string,
    failureMode: 'preserve' | 'suppress'
  ): Promise<DaemonAppliedPtySize | null> {
    return await readDaemonAppliedPtySize({
      client: this.client,
      protocolVersion: this.protocolVersion,
      sessionId: id,
      failureMode,
      getSizeUnsupported: this.getSizeUnsupported,
      markGetSizeUnsupported: () => {
        this.getSizeUnsupported = true
      }
    })
  }
}
