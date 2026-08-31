import type { ColdRestorePayload } from './cold-restore-payload-cache'
import { isUnknownRequestTypeError } from './daemon-endpoint-errors'
import { GET_SIZE_PROTOCOL_VERSION } from './daemon-protocol-version'
import { FinalCheckpointWaitExpiredError } from './daemon-pty-lifecycle-errors'
import { DaemonPtySessionSpawn } from './daemon-pty-session-spawn'
import { providerSequenceFromCreateOrAttach } from './daemon-pty-provider-sequence'
import { remainingDaemonRequestTimeoutMs } from './daemon-request-deadline'
import type { ColdRestoreInfo } from './history-reader'
import { normalizeWslColdRestoreCwd } from './wsl-cold-restore-cwd'
import { SessionNotFoundError, type CreateOrAttachResult, type ListSessionsResult } from './types'
import { resolveSafePtyDefaultCwd } from '../providers/pty-default-cwd'
import type { PtySpawnResult } from '../providers/types'
import { PtyWriteUnavailableError } from '../providers/pty-write-unavailable-error'
export const LIVENESS_PROBE_TIMEOUT_MS = 2_000

const MAX_TOMBSTONES = 1000

export abstract class DaemonPtySessionControl extends DaemonPtySessionSpawn {
  async attach(id: string): Promise<Pick<PtySpawnResult, 'providerSequence'> | void> {
    await this.ensureConnected()
    if (!this.canDelegateBackgroundToDaemon) {
      this.setPtyBackgrounded(id, false)
    }

    // Why size-first: attach must ride the session's own geometry — a fixed
    // 80×24 here could resize a live agent's TUI — and a null size means the
    // daemon cannot prove the session, so refuse rather than risk a create.
    const size = await this.getAppliedSize(id)
    if (!size) {
      throw new SessionNotFoundError(id)
    }
    const result = await this.client.request<CreateOrAttachResult>('createOrAttach', {
      sessionId: id,
      cols: size.cols,
      rows: size.rows,
      attachOnly: true
    })
    if (result.isNew) {
      // Why: a pre-v31 daemon ignores attachOnly; retire its accidental spawn
      // instead of publishing a fresh shell as an attach.
      await this.client.request('kill', { sessionId: id, immediate: true }).catch((error) => {
        // Why surface, not swallow: a failed retire leaves an untracked orphan shell.
        console.warn('[daemon] attach-only retire of accidental legacy spawn failed', {
          sessionId: id,
          error
        })
      })
      throw new SessionNotFoundError(id)
    }
    this.clearSessionAwaitingDaemonRecovery(id)
    const providerSequence = providerSequenceFromCreateOrAttach(result)
    return providerSequence ? { providerSequence } : undefined
  }

  hasPty(id: string): boolean {
    return this.activeSessionIds.has(id)
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
          // Why the capability probe rather than the version alone: `getSize` shipped into an
          // already-released protocol without a bump, so a daemon can report a version that
          // implies support and still reject the request. Ask what it can do, not what its
          // number implies — and remember the answer so later probes skip the dead round trip.
          if (!isUnknownRequestTypeError(error)) {
            throw error
          }
          this.getSizeUnsupported = true
        }
      }
      // Why: a daemon without `getSize` would otherwise answer `null` forever, and one `null`
      // makes the whole owner fan-out unprovable — a dead pane could then never be retired.
      // `listSessions` is the same inventory legacy discovery routes by, and has existed since
      // the first daemon protocol. Requested directly rather than through `listProcesses` so a
      // liveness probe does not publish inventory audit observations as a side effect; both
      // rethrow on failure, so either way a dead socket stays `null` instead of reading absent.
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

  write(id: string, data: string): boolean {
    const recoverable = this.prepareWrite(id)
    return this.finishWrite(id, this.client.notify('write', { sessionId: id, data }), recoverable)
  }

  async writeWithSettlement(id: string, data: string): Promise<boolean> {
    const recoverable = this.prepareWrite(id)
    return this.finishWrite(
      id,
      await this.client.notifyWithSettlement('write', { sessionId: id, data }),
      recoverable
    )
  }

  protected prepareWrite(id: string): boolean {
    this.markSessionDirty(id)
    // Why recoverable and not just active: rejecting a write asks the pane to remount,
    // which only helps if this endpoint can come back. A legacy adapter has no respawn,
    // so its reattach fails and the pane rebuilds empty — losing scrollback the user
    // could still read. Keep the pre-existing silent drop for those.
    const recoverable =
      this.activeSessionIds.has(id) && !this.respawnAdoptionClosed && Boolean(this.respawnFn)
    if (
      recoverable &&
      (this.sessionsAwaitingDaemonRecovery.has(id) || !this.client.isConnected())
    ) {
      this.sessionsAwaitingDaemonRecovery.add(id)
      this.reconnectAfterWriteFailure()
      throw new PtyWriteUnavailableError(`Daemon PTY "${id}" is awaiting recovery`)
    }
    return recoverable
  }

  protected finishWrite(id: string, delivered: boolean, recoverable: boolean): boolean {
    if (!delivered && recoverable) {
      this.sessionsAwaitingDaemonRecovery.add(id)
      this.reconnectAfterWriteFailure()
      throw new PtyWriteUnavailableError(`Daemon PTY "${id}" is awaiting recovery`)
    }
    return delivered
  }

  resize(id: string, cols: number, rows: number): void {
    this.markSessionDirty(id)
    this.client.notify('resize', { sessionId: id, cols, rows })
  }

  pauseProducer(id: string): void {
    if (!this.supportsProducerFlowControl) {
      return
    }
    this.pausedProducerSessionIds.add(id)
    this.client.notify('pausePty', { sessionId: id })
  }

  resumeProducer(id: string): void {
    this.producerResumesOwedOnReconnect.delete(id)
    if (!this.supportsProducerFlowControl) {
      return
    }
    this.pausedProducerSessionIds.delete(id)
    this.client.notify('resumePty', { sessionId: id })
  }

  // Why fire-and-forget (like pausePty): just a delivery hint for the daemon's keep-tail stream thinning.
  setPtyBackgrounded(id: string, background: boolean): void {
    if (!this.supportsProducerFlowControl) {
      return
    }
    // Why: preserved daemons without a sequence-safe, faithful serializer cannot heal a thinned stream.
    // Why also gate on 2031 (#9993): backgrounding is what hands transient-fact scan
    // authority to the daemon. A pre-v29 daemon can announce a 2031 subscribe but never
    // retract it, so a TUI exiting while hidden would strand the subscription and the
    // next theme flip would inject CSI 997 into its replacement shell. Declining to
    // background keeps main's scanner — which emits both facts — authoritative.
    const safeBackground = this.canDelegateBackgroundToDaemon && background
    if (safeBackground) {
      this.backgroundedSessionIds.add(id)
    } else {
      this.backgroundedSessionIds.delete(id)
    }
    this.client.notify('setSessionBackground', { sessionId: id, background: safeBackground })
  }

  async shutdown(
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ): Promise<void> {
    if (opts.keepHistory && this.disconnectOnlyPromise) {
      throw new Error('Cannot keep history after daemon disconnect has started')
    }
    const shutdown = this.withHistorySpawnLock(id, () => this.shutdownWithHistoryLock(id, opts))
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

  protected async shutdownWithHistoryLock(
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ): Promise<void> {
    // Why: shutdown can be the first lazy-client operation after restart; connect
    // before killing so a healthy daemon session is not orphaned (#7742). Connect,
    // the final-checkpoint wait, and kill all share the caller's one absolute
    // deadline, so neither a wedged handshake nor a stalled history write can burn
    // the whole teardown budget before the kill even starts. Only the waits are
    // bounded — the checkpoint itself stays deadline-free and lossless (STA-4228).
    await this.ensureConnected(opts.deadlineMs)
    // Why: sleep/exact-stop kills the live PTY before the periodic checkpoint may run.
    // Force a final snapshot so wake can restore the pane users left.
    if (opts.keepHistory) {
      const committed = await this.runExclusiveCheckpoint(
        async () => {
          await this.checkpointSessions([id], { final: true, teardown: true })
        },
        { callerDeadlineMs: opts.deadlineMs }
      )
      // Why throw instead of killing anyway: the snapshot the caller asked us to prove is still
      // being written. Killing here would race the wake-time restore source to disk, so report the
      // pty unverified and leave it alive — worktree sleep declines to commit it and retries.
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
        // Why: physical exit must not mark intentional sleep as a clean end; the final checkpoint stays the wake-time recovery authority.
        this.historyManager?.suspendSession(id)
      } else if (
        detection?.status === 'unreadable' ||
        (detection?.status === 'restored' && detection.hasUnreadableRecovery)
      ) {
        this.historyManager?.suspendSession(id)
      }
    }
    await this.client.request(
      'kill',
      { sessionId: id, immediate: opts.immediate ?? false },
      remainingDaemonRequestTimeoutMs(opts.deadlineMs)
    )
    this.activeSessionIds.delete(id)
    this.clearSessionAwaitingDaemonRecovery(id)
    this.dirtySessionVersions.delete(id)
    if (!opts.keepHistory) {
      this.coldRestoreCache.delete(id)
      this.sleepRestoreSessionIds.delete(id)
    }
    // Why: the !keepHistory path takes no final checkpoint, so clear sessionsNeedingFullCheckpoint here or it stays stranded (no-op under keepHistory).
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
    // Why: only remove history on explicit close; sleep also calls shutdown but wake needs the dir intact for cold restore (opts.keepHistory).
    if (this.historyManager && !opts.keepHistory) {
      await this.historyManager
        .removeSession(id)
        .catch((err) => console.warn('[history] removeSession failed:', id, err))
    }

    // Why: the tombstone rejects reattach to a user-killed session; sleep legitimately reattaches on wake, so skip it under keepHistory.
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
    // Why: alt-screen prefers normal scrollback, else snapshotAnsi alone — not rehydrate, which starts with \x1b[?1049h that POST_REPLAY_MODE_RESET won't undo — so a hibernated TUI's last frame isn't blank on wake.
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

  // Why: resize() is fire-and-forget and can be dropped daemon-side; read the actually-applied size so the renderer can detect drift and re-assert.
  async getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    try {
      const result = await this.client.request<{ size: { cols: number; rows: number } | null }>(
        'getSize',
        { sessionId: id }
      )
      return result.size ?? null
    } catch {
      return null
    }
  }
}
