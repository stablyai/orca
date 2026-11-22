import {
  isPtyFencedTerminationOutcome,
  type PtyFencedTerminationRequest,
  type PtyFencedTerminationOutcome
} from '../../../../shared/terminal/pty/lifecycle/pty-fenced-termination'
import {
  FENCED_HISTORY_CHECKPOINT_PROTOCOL_VERSION,
  FENCED_TERMINATION_PROTOCOL_VERSION
} from '../../protocol/daemon-protocol-version'
import { DaemonPtySessionControl } from './daemon-pty-session-control'
import type { RevalidateFencedPtyRoute } from '../../../providers/pty/provider-contract'
import { FinalCheckpointWaitExpiredError } from './daemon-pty-lifecycle-errors'
import { readDaemonLiveSleepCwd } from './daemon-live-sleep-cwd'
import { normalizeWslColdRestoreCwd } from '../wsl/wsl-cold-restore-cwd'
import { logSleepFolderRead, readDaemonWslSleepCwdWithFacts } from '../wsl/daemon-wsl-sleep-cwd'
import { resolveSafePtyDefaultCwd } from '../../../providers/working-directory/default-cwd'

export abstract class DaemonPtySessionRetirement extends DaemonPtySessionControl {
  protected override clearExitedSessionState(
    id: string,
    code: number,
    incarnationId?: string,
    options?: { closeHistory?: boolean }
  ): void {
    const historyStop = this.fencedHistoryStops.get(id)
    const currentIncarnation = this.ptyInventory.currentIncarnation(id)
    if (
      historyStop &&
      historyStop.incarnationId === incarnationId &&
      (!currentIncarnation || currentIncarnation === incarnationId)
    ) {
      this.fencedHistoryStops.delete(id)
      historyStop.preserve()
      options = { closeHistory: false }
    }
    super.clearExitedSessionState(id, code, incarnationId, options)
  }

  supportsFencedTermination(_id: string): boolean {
    return this.protocolVersion >= FENCED_TERMINATION_PROTOCOL_VERSION
  }

  async killFenced(
    request: PtyFencedTerminationRequest,
    authorize?: () => void,
    revalidateRoute?: RevalidateFencedPtyRoute
  ): Promise<PtyFencedTerminationOutcome> {
    if (!this.supportsFencedTermination(request.id)) {
      return { outcome: 'refused', reason: 'unsupported' }
    }
    const keepHistory = request.keepHistory === true
    if (keepHistory && this.disconnectOnlyPromise) {
      return { outcome: 'refused', reason: 'unverifiable' }
    }
    if (keepHistory && this.protocolVersion < FENCED_HISTORY_CHECKPOINT_PROTOCOL_VERSION) {
      return { outcome: 'refused', reason: 'unsupported' }
    }
    // Capture the checked identity before waiting on connection or lifecycle locks.
    const { id, expectedIncarnationId, requireNoAgentOwner, requireUnattached } = request
    const run = async (): Promise<PtyFencedTerminationOutcome> => {
      let historyAdopted = !keepHistory
      if (keepHistory && this.historyManager) {
        await this.ensureConnected()
        try {
          await this.adoptListedSessionForSleep(id, undefined, expectedIncarnationId)
          historyAdopted = true
        } catch {
          // Missing history preparation only permits a read-only exit proof.
        }
      }
      return await this.withHistorySpawnLock(id, async () => {
        const incarnationBeforeKill = this.sessionIncarnations.get(id)
        await this.ensureConnected()
        const preserve =
          keepHistory && historyAdopted
            ? await this.prepareHistoryForShutdown(id, { expectedIncarnationId }).catch(
                () => undefined
              )
            : undefined
        const verifyExitOnly = keepHistory && !preserve
        const route = revalidateRoute ? await revalidateRoute() : undefined
        if (route === 'already_exited') {
          authorize?.()
          return { outcome: 'already_exited' }
        }
        route?.()
        if (!verifyExitOnly) {
          authorize?.()
        }
        const priorHistoryStop = this.fencedHistoryStops.get(id)
        const samePriorHistoryStop = priorHistoryStop?.incarnationId === expectedIncarnationId
        if (preserve && !samePriorHistoryStop) {
          this.fencedHistoryStops.set(id, { incarnationId: expectedIncarnationId, preserve })
        }
        const result = await this.client.request<unknown>('kill', {
          sessionId: id,
          immediate: true,
          expectedIncarnationId,
          requireNoAgentOwner,
          requireUnattached,
          ...(verifyExitOnly ? { verifyExitOnly: true as const } : {})
        })
        if (
          !isPtyFencedTerminationOutcome(result) ||
          (verifyExitOnly && result.outcome === 'ended')
        ) {
          return { outcome: 'refused', reason: 'unverifiable' }
        }
        if (verifyExitOnly && result.outcome === 'already_exited') {
          authorize?.()
        }
        if (
          result.outcome === 'refused' &&
          result.reason !== 'unverifiable' &&
          (!samePriorHistoryStop || result.reason === 'replaced') &&
          this.fencedHistoryStops.get(id)?.incarnationId === expectedIncarnationId
        ) {
          this.fencedHistoryStops.delete(id)
        }
        const currentIncarnationId = this.sessionIncarnations.get(id)
        if (
          (result.outcome === 'ended' || result.outcome === 'already_exited') &&
          (incarnationBeforeKill === undefined ||
            incarnationBeforeKill === expectedIncarnationId) &&
          (currentIncarnationId === undefined || currentIncarnationId === expectedIncarnationId)
        ) {
          const historyStop = this.fencedHistoryStops.get(id)
          this.fencedHistoryStops.delete(id)
          historyStop?.preserve()
          // Exit may clear the incarnation first; hold the spawn lock through removal to protect replacement sessions.
          await this.completeShutdownWithHistoryLock(id, { keepHistory: request.keepHistory })
        }
        return result
      })
    }
    try {
      return await (keepHistory ? this.trackKeepHistoryShutdown(run) : run())
    } catch {
      return { outcome: 'refused', reason: 'unverifiable' }
    }
  }

  protected async prepareHistoryForShutdown(
    id: string,
    opts: { deadlineMs?: number; expectedIncarnationId?: string }
  ): Promise<() => void> {
    // A restart can precede the first periodic checkpoint.
    if (!this.historyManager) {
      return () => {}
    }
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
          const checkpointed = await this.checkpointSessions([id], {
            final: true,
            // A fenced checkpoint may still be refused; keep the running shell's scanner intact.
            teardown: opts.expectedIncarnationId === undefined,
            expectedIncarnationId: opts.expectedIncarnationId
          })
          if (opts.expectedIncarnationId !== undefined && !checkpointed.has(id)) {
            throw new Error('Could not preserve the fenced terminal history')
          }
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
    if (opts.expectedIncarnationId !== undefined) {
      return () => {
        // Later live checkpoints may have committed before the daemon confirmed exit.
        this.coldRestoreCache.delete(id)
        this.sleepRestoreSessionIds.delete(id)
        this.historyManager?.suspendSession(id)
      }
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
    return () => {
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
  }
}
