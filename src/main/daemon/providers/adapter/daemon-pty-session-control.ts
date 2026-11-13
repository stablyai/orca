import {
  coldRestorePayloadFromInfo,
  type ColdRestorePayload
} from '../../history/restoration/cold-restore-payload-cache'
import { isUnknownRequestTypeError } from '../../endpoint/identity/daemon-endpoint-errors'
import { GET_SIZE_PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'
import { readDaemonAppliedPtySize, type DaemonAppliedPtySize } from './daemon-pty-applied-size'
import { FinalCheckpointWaitExpiredError } from './daemon-pty-lifecycle-errors'
import { DaemonPtySessionInput } from './daemon-pty-session-input'
import { remainingDaemonRequestTimeoutMs } from '../../launch/daemon-request-deadline'
import { readDaemonSleepFolder } from './daemon-live-sleep-cwd'
import type { ColdRestoreInfo } from '../../history/restoration/terminal-history-cold-restore-info'
import * as unlistedSession from '../routing/daemon-unlisted-session'
import { SessionNotFoundError } from '../../protocol/daemon-errors'
import type { ListSessionsResult } from '../../protocol/daemon-rpc-contract'
import type { HostHistoryBinding, ShutdownOptions } from './daemon-pty-host-history'
import type { InventoryRequest } from './daemon-pty-inventory-observation'
import { sleepHostTarget } from './daemon-pty-host-sleep'
import type { PtySpawnResult } from '../../../providers/pty-provider-contract'

export const LIVENESS_PROBE_TIMEOUT_MS = 2_000

const MAX_TOMBSTONES = 1000
// A busy daemon must not eat the final checkpoint's share of the Sleep deadline.

export abstract class DaemonPtySessionControl extends DaemonPtySessionInput {
  protected abstract adoptListedSessionForSleep(
    sessionId: string,
    deadlineMs: number | undefined,
    observation: InventoryRequest,
    captured: HostHistoryBinding | undefined
  ): Promise<HostHistoryBinding | undefined>

  /** A legacy Sleep's final checkpoint and cold-restore cache; refuses before the kill if unsaved. */
  protected abstract saveLegacySleepHistory(
    id: string,
    opts: ShutdownOptions,
    sleepCwd: string | null
  ): Promise<void>

  async attach(id: string): Promise<PtySpawnResult> {
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
    // A restarted runtime has never seen the surviving session's screen or title.
    return result
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
      // The close's removal claim is captured here, before any lock or kill await.
      const historyAdmission = this.historyStore?.hold(id)
      try {
        await this.withHistorySpawnLock(id, () =>
          this.shutdownWithHistoryLock(id, { ...opts, historyAdmission })
        )
      } finally {
        this.historyStore?.drop(id, historyAdmission, !this.hostHistory.enabled)
      }
      return
    }
    // Before any await: this Sleep ends only the binding it began with, never one installed while
    // it waited, and the observation records every same-ID spawn, exit or reconnect meanwhile.
    const observation = this.ptyInventory.begin(id)
    const captured = this.hostHistory.enabled ? this.hostHistory.get(id) : undefined
    const shutdown = Promise.resolve().then(async () => {
      try {
        // Outside the spawn lock, which adopting the session's history takes itself.
        await this.ensureConnected(opts.deadlineMs)
        let binding = captured
        try {
          binding = await this.adoptListedSessionForSleep(
            id,
            opts.deadlineMs,
            observation,
            captured
          )
        } catch (error) {
          // A superseded target refuses this Sleep; other adoption failures keep their old policy.
          if (error instanceof FinalCheckpointWaitExpiredError) {
            throw error
          }
        }
        const sleepTarget = { binding, observation }
        await this.withHistorySpawnLock(id, () =>
          this.shutdownWithHistoryLock(id, { ...opts, sleepTarget })
        )
      } finally {
        this.ptyInventory.end(observation)
      }
    })
    this.keepHistoryShutdowns.add(shutdown)
    try {
      await shutdown
    } finally {
      this.keepHistoryShutdowns.delete(shutdown)
    }
  }

  protected async shutdownWithHistoryLock(id: string, opts: ShutdownOptions): Promise<void> {
    // Connect lazily, sharing one deadline with checkpoint waits and kill; durable writes themselves remain unbounded.
    await this.ensureConnected(opts.deadlineMs)
    // Sleep may precede the first periodic checkpoint; persist the screen before killing.
    if (opts.keepHistory) {
      const probeFolder = () =>
        readDaemonSleepFolder(this.client, id, {
          wslDistro: this.wslDistrosBySessionId.get(id),
          paneKey: this.wslPaneKeysBySessionId.get(id),
          live: this.activeSessionIds.has(id),
          deadlineMs: opts.deadlineMs
        })
      if (this.hostHistory.enabled) {
        // Only the binding this Sleep began with (or adopted for it) may end.
        const slept = await sleepHostTarget(
          id,
          opts.sleepTarget,
          {
            client: this.client,
            bindings: this.hostHistory,
            inventory: this.ptyInventory,
            probeFolder
          },
          opts
        )
        return this.completeShutdownWithHistoryLock(id, opts, slept)
      }
      await this.saveLegacySleepHistory(id, opts, await probeFolder())
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

  /**
   * Complete an explicit close without issuing another kill; the caller holds the spawn/history
   * lock. A captured incarnation cleans up only that binding, never a same-ID successor.
   */
  protected async completeShutdownWithHistoryLock(
    id: string,
    opts: Pick<ShutdownOptions, 'keepHistory' | 'historyAdmission'>,
    capturedIncarnationId?: string
  ): Promise<void> {
    if (capturedIncarnationId !== undefined) {
      this.hostHistory.release(id, capturedIncarnationId)
      const current = this.ptyInventory.currentIncarnation(id)
      if (current !== undefined && current !== capturedIncarnationId) {
        return
      }
    }
    this.ptyInventory.retire(id, capturedIncarnationId ?? this.ptyInventory.currentIncarnation(id))
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
    if (this.historyStore && !opts.keepHistory) {
      await this.historyStore
        .removeSession(id, opts.historyAdmission)
        .catch((err) => console.warn('[history] removeSession failed:', id, err))
    }
    this.hostHistory.release(id)

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
