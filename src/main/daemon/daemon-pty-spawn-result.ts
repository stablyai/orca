import { isAgentSessionClaimedSpawnResult } from '../../shared/agent-session-host-authority'
import { parseTerminalKittyKeyboardFlags } from '../../shared/terminal-kitty-keyboard-flags'
import { DaemonPtySpawnRequest, type DaemonPtySpawnContext } from './daemon-pty-spawn-request'
import { providerSequenceFromCreateOrAttach } from './daemon-pty-provider-sequence'
import { takeHistoryRecoveryFreeze } from './daemon-history-recovery-freeze'
import { getRecoveredHistorySeedSegments } from './terminal-history-seed-segments'
import { SessionNotFoundError, type CreateOrAttachResult } from './types'
import type { PtySpawnResult } from '../providers/types'

export abstract class DaemonPtySpawnResult extends DaemonPtySpawnRequest {
  protected async finishSpawn(
    context: DaemonPtySpawnContext,
    initialResult: CreateOrAttachResult
  ): Promise<PtySpawnResult> {
    const {
      opts,
      operation,
      historyRecovery,
      requestedSessionId,
      emulateLegacyAttachOnly,
      restoreSkippedForLiveSession,
      detectColdRestore
    } = context
    let { sessionId, wslDistro, restoreInfo, effectiveCwd, effectiveCols, effectiveRows } = context
    const createOrAttach = (historySeedSegments: readonly string[] | null) => {
      Object.assign(context, {
        sessionId,
        effectiveCwd,
        effectiveCols,
        effectiveRows
      })
      return this.createOrAttachSpawn(context, historySeedSegments)
    }
    let result = initialResult
    let historySeedSegments = restoreInfo ? getRecoveredHistorySeedSegments(restoreInfo) : null
    const adoptSpawnResultSession = async (spawnResult: CreateOrAttachResult): Promise<void> => {
      const requestedSessionId = sessionId
      if (
        opts.agentSessionEnsure &&
        !isAgentSessionClaimedSpawnResult(spawnResult.agentSessionEnsure)
      ) {
        // Why: a claim-incapable owner may already have spawned before returning
        // a malformed response; retire only this requested session before failing closed.
        await this.client.request('kill', { sessionId: requestedSessionId }).catch(() => {})
        throw new Error('agent_session_claim_unavailable')
      }
      sessionId = spawnResult.agentSessionEnsure?.owner.ptyId ?? requestedSessionId
      context.sessionId = sessionId
      if (requestedSessionId === sessionId) {
        return
      }
      if (historyRecovery.freeze) {
        this.historyManager?.abandonRecoveryFreeze(historyRecovery.freeze)
        historyRecovery.freeze = null
      }
      historyRecovery.unreadableSessionId = null
      historyRecovery.identityChanged = true
      restoreInfo = null
      historySeedSegments = null
    }
    if (emulateLegacyAttachOnly && result.isNew) {
      operation.ignoreNextExit = true
      await this.client.request('kill', { sessionId: requestedSessionId, immediate: true })
      throw new SessionNotFoundError(requestedSessionId)
    }
    await adoptSpawnResultSession(result)
    // Both ids: adoptSpawnResultSession may have rewritten sessionId to the claim owner.
    this.clearSessionAwaitingDaemonRecovery(requestedSessionId)
    this.clearSessionAwaitingDaemonRecovery(sessionId)
    const exitedResult = this.resultForExitBeforeSpawnReply(sessionId, result, operation)
    if (exitedResult) {
      return exitedResult
    }
    if (result.incarnationId) {
      this.sessionIncarnations.set(sessionId, result.incarnationId)
    }
    const claimResult = (): Pick<PtySpawnResult, 'agentSessionEnsure'> | Record<string, never> =>
      result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {}
    const incarnationResult = (): Pick<PtySpawnResult, 'incarnationId'> | Record<string, never> =>
      result.incarnationId ? { incarnationId: result.incarnationId } : {}
    let providerWslDistro = result.wslDistro === undefined ? wslDistro : result.wslDistro
    // Why: explicit null from a current daemon overrides the caller's WSL preference; undefined keeps compatibility with older daemons.
    wslDistro = providerWslDistro ?? undefined
    context.wslDistro = wslDistro
    if (wslDistro) {
      this.wslDistrosBySessionId.set(sessionId, wslDistro)
    } else if (providerWslDistro === null || result.isNew) {
      this.wslDistrosBySessionId.delete(sessionId)
    }
    const launchIdentity = (): { launchAgent?: NonNullable<typeof result.launchAgent> } =>
      result.launchAgent ? { launchAgent: result.launchAgent } : {}

    if (effectiveCwd) {
      this.initialCwds.set(sessionId, effectiveCwd)
    }

    // Why: surface the daemon's shell pid via PtySpawnResult so ipc/pty registers with the memory collector without a provider-specific accessor.
    let pid = typeof result.pid === 'number' && result.pid > 0 ? result.pid : null

    // Why: check sticky cache first — StrictMode double-mounts call spawn twice; the second call (isNew=false) must still return cached cold restore data.
    const cachedRestore = this.coldRestoreCache.get(sessionId)
    if (cachedRestore) {
      // Why: wake-after-sleep lands here too; sleep dropped active tracking + the history writer, so re-register both or the next sleep/wake restores a blank terminal.
      this.activeSessionIds.add(sessionId)
      if (this.historyManager && !historyRecovery.identityChanged) {
        const recoveryFreeze = takeHistoryRecoveryFreeze(historyRecovery, sessionId)
        if (historyRecovery.unreadableSessionId === sessionId) {
          this.historyManager.suspendSession(sessionId, recoveryFreeze)
        } else {
          this.historyManager.reopenSession(sessionId, recoveryFreeze)
        }
      }
      return {
        id: sessionId,
        ...incarnationResult(),
        pid,
        ...claimResult(),
        ...launchIdentity(),
        coldRestore: cachedRestore,
        ...(providerWslDistro !== undefined ? { wslDistro: providerWslDistro } : {}),
        ...(!result.isNew ? { isReattach: true } : {})
      }
    }

    // Why: the probe→createOrAttach gap is racy — the session can exit in between, so re-detect to match the unprobed restore path.
    // Why ignoreCleanEnd: the raced exit event can write endedAt before the reply; nulling the restore here would delete the checkpoint instead of restoring it.
    if (!historyRecovery.identityChanged && result.isNew && restoreSkippedForLiveSession) {
      restoreInfo = await detectColdRestore({ ignoreCleanEnd: true })
      historySeedSegments = restoreInfo ? getRecoveredHistorySeedSegments(restoreInfo) : null
      if (restoreInfo && historySeedSegments && historySeedSegments.length > 0) {
        // Why: the aliveness probe raced with session death, so the first
        // create lacked recovery bytes. Replace it before exposing the PTY.
        if (result.incarnationId) {
          operation.ignoredExitIncarnationIds.add(result.incarnationId)
        }
        operation.ignoreNextExit = true
        await this.client.request('kill', { sessionId, immediate: true })
        effectiveCwd = restoreInfo.cwd
        effectiveCols = restoreInfo.cols
        effectiveRows = restoreInfo.rows
        result = await createOrAttach(historySeedSegments)
        await adoptSpawnResultSession(result)
        const exitedRetryResult = this.resultForExitBeforeSpawnReply(sessionId, result, operation)
        if (exitedRetryResult) {
          return exitedRetryResult
        }
        if (result.incarnationId) {
          this.sessionIncarnations.set(sessionId, result.incarnationId)
        }
        providerWslDistro = result.wslDistro === undefined ? wslDistro : result.wslDistro
        wslDistro = providerWslDistro ?? undefined
        context.wslDistro = wslDistro
        if (wslDistro) {
          this.wslDistrosBySessionId.set(sessionId, wslDistro)
        } else if (providerWslDistro === null || result.isNew) {
          this.wslDistrosBySessionId.delete(sessionId)
        }
        pid = typeof result.pid === 'number' && result.pid > 0 ? result.pid : null
        this.initialCwds.set(sessionId, effectiveCwd)
      }
    } else if (
      !historyRecovery.identityChanged &&
      !result.isNew &&
      result.historySeeded === false
    ) {
      restoreInfo = await detectColdRestore()
      historySeedSegments = restoreInfo ? getRecoveredHistorySeedSegments(restoreInfo) : null
    }

    const wasAlreadyManaged = this.activeSessionIds.has(sessionId)
    this.activeSessionIds.add(sessionId)
    const providerSequence = providerSequenceFromCreateOrAttach(result)

    // Cold restore: daemon made a new session but disk history shows an unclean shutdown → return saved scrollback.
    if (restoreInfo && (result.isNew || result.historySeeded === false)) {
      const coldRestore = this.buildColdRestorePayload(restoreInfo)
      const canReanchorHistory =
        !historySeedSegments || historySeedSegments.length === 0 || result.historySeeded === true
      // Why: registerWriter (not openSession) avoids deleting checkpoint.json — the only recovery data if the revived daemon crashes before the next tick.
      if (this.historyManager && !historyRecovery.identityChanged) {
        const recoveryFreeze = takeHistoryRecoveryFreeze(historyRecovery, sessionId)
        if (historyRecovery.unreadableSessionId === sessionId) {
          await this.historyManager.openSession(sessionId, {
            cwd: effectiveCwd ?? '',
            cols: effectiveCols,
            rows: effectiveRows,
            ...(recoveryFreeze ? { recoveryFreeze } : {}),
            quarantineUnreadableRecovery: true
          })
          if (this.historyManager.hasWriter(sessionId)) {
            this.sessionsNeedingFullCheckpoint.add(sessionId)
            this.sessionsNeedingLiveCheckpoint.add(sessionId)
            this.lastFullCheckpointAt.delete(sessionId)
          }
        } else if (canReanchorHistory) {
          this.historyManager.registerWriter(sessionId, recoveryFreeze)
          this.sessionsNeedingFullCheckpoint.add(sessionId)
          // Why: the revived generation has no valid checkpoint yet; a cooldown inherited from the pre-crash generation must not defer this re-anchor.
          this.lastFullCheckpointAt.delete(sessionId)
        } else {
          // Preserve old recovery files when the new daemon can't include them; a fresh-only checkpoint would make the data loss permanent.
          this.historyManager.suspendSession(sessionId, recoveryFreeze)
        }
      }
      if (coldRestore) {
        this.coldRestoreCache.set(sessionId, coldRestore)
        return {
          id: sessionId,
          ...incarnationResult(),
          pid,
          ...claimResult(),
          ...launchIdentity(),
          coldRestore,
          ...(providerWslDistro !== undefined ? { wslDistro: providerWslDistro } : {}),
          ...(providerSequence ? { providerSequence } : {}),
          ...(!result.isNew ? { isReattach: true } : {})
        }
      }
      return {
        id: sessionId,
        ...incarnationResult(),
        pid,
        ...claimResult(),
        ...launchIdentity(),
        ...(providerWslDistro !== undefined ? { wslDistro: providerWslDistro } : {}),
        ...(providerSequence ? { providerSequence } : {})
      }
    }

    if (this.historyManager && !historyRecovery.identityChanged && result.isNew) {
      const recoveryFreeze = takeHistoryRecoveryFreeze(historyRecovery, sessionId)
      await this.historyManager.openSession(sessionId, {
        cwd: effectiveCwd ?? '',
        cols: effectiveCols,
        rows: effectiveRows,
        ...(recoveryFreeze ? { recoveryFreeze } : {}),
        ...(historyRecovery.unreadableSessionId === sessionId
          ? { quarantineUnreadableRecovery: true }
          : {})
      })
    } else if (
      this.historyManager &&
      !historyRecovery.identityChanged &&
      (result.historySeeded === false || historyRecovery.unreadableSessionId === sessionId)
    ) {
      // Why: the daemon keeps this failure bit with the live session, so a new adapter can't promote its fresh-only snapshot after restart.
      this.historyManager.suspendSession(
        sessionId,
        takeHistoryRecoveryFreeze(historyRecovery, sessionId)
      )
    } else if (this.historyManager && !historyRecovery.identityChanged) {
      // Why: on warm reattach after relaunch the HistoryManager is fresh; registerWriter adds a writer without deleting the still-only-valid checkpoint.
      this.historyManager.registerWriter(
        sessionId,
        takeHistoryRecoveryFreeze(historyRecovery, sessionId)
      )
      if (!wasAlreadyManaged) {
        // Why: a previous adapter may have drained records it never persisted, so the first compact must prove disk-to-daemon continuity.
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        this.sessionsNeedingContinuityCheckpoint.add(sessionId)
        this.lastFullCheckpointAt.delete(sessionId)
      }
    }

    const isReattach = !result.isNew
    if (!isReattach || !result.snapshot) {
      return {
        id: sessionId,
        ...incarnationResult(),
        pid,
        ...claimResult(),
        ...launchIdentity(),
        ...(providerWslDistro !== undefined ? { wslDistro: providerWslDistro } : {}),
        ...(providerSequence ? { providerSequence } : {}),
        ...(isReattach ? { isReattach: true } : {})
      }
    }

    const reattachSnapshot = await this.overlayDurableRestoreSnapshot(sessionId, result.snapshot)
    const reattachProviderSequence =
      typeof reattachSnapshot.outputSequence === 'number'
        ? { value: reattachSnapshot.outputSequence, generation: 'continued' as const }
        : providerSequence
    const isAltScreen = reattachSnapshot.modes.alternateScreen
    const snapshotPrefix = reattachSnapshot.scrollbackAnsi + reattachSnapshot.rehydrateSequences
    const snapshotFrame = reattachSnapshot.snapshotAnsi
    const snapshotPayload = snapshotPrefix + snapshotFrame
    // Why kitty flags ride beside the payload, not inside it: the snapshot reaches renderer xterms where POST_REPLAY_REATTACH_RESET's kitty reset must win (terminal-query-authority.md §kitty).
    // Why known `0` is no longer dropped: the pane tracker must be able to tell
    // "the app negotiated nothing" from "this reattach proved nothing".
    const kittyKeyboardFlags = parseTerminalKittyKeyboardFlags(
      reattachSnapshot.modes.kittyKeyboardFlags
    )
    return {
      id: sessionId,
      ...incarnationResult(),
      pid,
      ...claimResult(),
      ...launchIdentity(),
      ...(providerWslDistro !== undefined ? { wslDistro: providerWslDistro } : {}),
      snapshot: snapshotPayload,
      snapshotCols: reattachSnapshot.cols,
      snapshotRows: reattachSnapshot.rows,
      // Why only for an alt frame: normal history remains safe to replay at its capture grid.
      ...(isAltScreen && snapshotFrame && reattachSnapshot.frameRestoreAnsi
        ? {
            snapshotPrefixAnsi: snapshotPrefix,
            snapshotFrameAnsi: snapshotFrame,
            snapshotFrameRestoreAnsi: reattachSnapshot.frameRestoreAnsi
          }
        : {}),
      ...(reattachProviderSequence ? { providerSequence: reattachProviderSequence } : {}),
      ...(kittyKeyboardFlags !== undefined
        ? { snapshotKittyKeyboardFlags: kittyKeyboardFlags }
        : {}),
      ...(reattachSnapshot.terminalOwner
        ? { snapshotTerminalOwner: reattachSnapshot.terminalOwner }
        : {}),
      isReattach: true,
      isAlternateScreen: isAltScreen,
      // Why: the snapshot ANSI has no title frame; carry lastTitle beside it so main can seed title records after a relaunch.
      ...(reattachSnapshot.lastTitle ? { lastTitle: reattachSnapshot.lastTitle } : {}),
      // Why: carry the mid-escape tail so the renderer writes it after the reattach reset, else a split escape renders literally (#7329).
      ...(reattachSnapshot.pendingEscapeTailAnsi
        ? { pendingEscapeTailAnsi: reattachSnapshot.pendingEscapeTailAnsi }
        : {})
    }
  }
}
