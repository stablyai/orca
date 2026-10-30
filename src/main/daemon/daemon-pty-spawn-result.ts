import { isAgentSessionClaimedSpawnResult } from '../../shared/agent-session-host-authority'
import { parseTerminalKittyKeyboardFlags } from '../../shared/terminal-kitty-keyboard-flags'
import { daemonSpawnResultIdentity } from './daemon-spawn-result-identity'
import { retireUnexpectedAttachOnlySpawn } from './daemon-attach-only-retirement'
import { DaemonPtySpawnRequest, type DaemonPtySpawnContext } from './daemon-pty-spawn-request'
import { providerSequenceFromCreateOrAttach } from './daemon-pty-provider-sequence'
import { takeHistoryRecoveryFreeze } from './daemon-history-recovery-freeze'
import { getRecoveredHistorySeedSegments } from './terminal-history-seed-segments'
import { SessionNotFoundError, type CreateOrAttachResult } from './types'
import type { PtySpawnResult } from '../providers/pty-provider-contract'

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
      attachOnly,
      restoreSkippedForLiveSession
    } = context
    let { sessionId, wslDistro, restoreInfo, effectiveCwd, effectiveCols, effectiveRows } = context
    const createOrAttach = async (historySeedSegments: readonly string[] | null) => {
      Object.assign(context, { sessionId, restoreInfo, effectiveCwd, effectiveCols, effectiveRows })
      const created = await this.createOrAttachSpawn(context, historySeedSegments)
      // Why: a spawn whose restored folder was gone retried in the asked one; keep that, not the gone one.
      ;({ effectiveCwd, restoreInfo } = context)
      return created
    }
    let result = initialResult
    const finalizeSpawnResult = (spawnResult: PtySpawnResult): PtySpawnResult =>
      this.resultForExitBeforeSpawnReply(sessionId, result, operation) ??
      (result.isNew && !historyRecovery.identityChanged
        ? {
            ...spawnResult,
            startupCwdSource: effectiveCwd === opts.cwd ? 'request' : 'recovered-history'
          }
        : spawnResult)
    let historySeedSegments = restoreInfo ? getRecoveredHistorySeedSegments(restoreInfo) : null
    const adoptSpawnResultSession = async (spawnResult: CreateOrAttachResult): Promise<void> => {
      const requestedSessionId = sessionId
      if (
        opts.agentSessionEnsure &&
        !isAgentSessionClaimedSpawnResult(spawnResult.agentSessionEnsure)
      ) {
        // A malformed claimed response may follow a spawn; retire only the requested session before rejecting.
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
    if (attachOnly && result.isNew) {
      operation.ignoreNextExit = true
      await retireUnexpectedAttachOnlySpawn(requestedSessionId, () =>
        this.client.request('kill', { sessionId: requestedSessionId, immediate: true })
      )
      throw new SessionNotFoundError(requestedSessionId)
    }
    await adoptSpawnResultSession(result)
    // Both ids: adoptSpawnResultSession may have rewritten sessionId to the claim owner.
    this.clearSessionAwaitingDaemonRecovery(requestedSessionId)
    this.clearSessionAwaitingDaemonRecovery(sessionId)
    this.ptyInventory.spawned(sessionId, result.incarnationId)
    const exitedResult = this.resultForExitBeforeSpawnReply(sessionId, result, operation)
    if (exitedResult) {
      return exitedResult
    }
    if (result.incarnationId) {
      this.sessionIncarnations.set(sessionId, result.incarnationId)
    }
    this.inputClosedIncarnations.sync(sessionId, result)
    this.hostLossSessionIds.delete(sessionId)
    let providerWslDistro = result.wslDistro === undefined ? wslDistro : result.wslDistro
    // Null overrides caller WSL preference; undefined preserves compatibility with older daemons.
    wslDistro = providerWslDistro ?? undefined
    context.wslDistro = wslDistro
    this.noteSpawnWslDistro(
      sessionId,
      wslDistro,
      providerWslDistro === null || result.isNew,
      result.incarnationId
    )
    if (wslDistro && opts.env?.ORCA_PANE_KEY) {
      this.wslPaneKeysBySessionId.set(sessionId, opts.env.ORCA_PANE_KEY)
    }

    if (effectiveCwd) {
      this.initialCwds.set(sessionId, effectiveCwd)
    }

    let pid = typeof result.pid === 'number' && result.pid > 0 ? result.pid : null

    // StrictMode can spawn twice; cached cold restore must survive the second, non-new result.
    const cachedRestore = this.coldRestoreCache.get(sessionId)
    if (cachedRestore) {
      // Wake reused the cache after dropping tracking and the writer; restore both for the next sleep cycle.
      this.activeSessionIds.add(sessionId)
      if (this.historyManager && !historyRecovery.identityChanged) {
        const recoveryFreeze = takeHistoryRecoveryFreeze(historyRecovery, sessionId)
        if (historyRecovery.unreadableSessionId === sessionId) {
          this.historyManager.suspendSession(sessionId, recoveryFreeze)
        } else {
          this.historyManager.reopenSession(sessionId, recoveryFreeze)
          if (result.isNew) {
            // A new process seeded with the fresh-shell padding: its output must not append to a
            // checkpoint that lacks that padding, or a later replay prints its prompt on the old one.
            this.sessionsNeedingFullCheckpoint.add(sessionId)
            this.lastFullCheckpointAt.delete(sessionId)
          }
        }
      }
      return finalizeSpawnResult({
        id: sessionId,
        ...daemonSpawnResultIdentity(result),
        pid,
        coldRestore: cachedRestore,
        ...(providerWslDistro !== undefined ? { wslDistro: providerWslDistro } : {}),
        ...(!result.isNew ? { isReattach: true } : {})
      })
    }

    // Recheck recovery after probe-to-create races; a raced clean-exit marker must not discard the checkpoint.
    if (!historyRecovery.identityChanged && result.isNew && restoreSkippedForLiveSession) {
      restoreInfo = await context.detectColdRestore({ ignoreCleanEnd: true })
      historySeedSegments = restoreInfo ? getRecoveredHistorySeedSegments(restoreInfo) : null
      if (restoreInfo && historySeedSegments && historySeedSegments.length > 0) {
        // Replace the unseeded race winner with a restored PTY before publishing it.
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
        this.ptyInventory.spawned(sessionId, result.incarnationId)
        const exitedRetryResult = this.resultForExitBeforeSpawnReply(sessionId, result, operation)
        if (exitedRetryResult) {
          return exitedRetryResult
        }
        if (result.incarnationId) {
          this.sessionIncarnations.set(sessionId, result.incarnationId)
        }
        this.inputClosedIncarnations.sync(sessionId, result)
        this.hostLossSessionIds.delete(sessionId)
        providerWslDistro = result.wslDistro === undefined ? wslDistro : result.wslDistro
        wslDistro = providerWslDistro ?? undefined
        context.wslDistro = wslDistro
        this.noteSpawnWslDistro(
          sessionId,
          wslDistro,
          providerWslDistro === null || result.isNew,
          result.incarnationId
        )
        pid = typeof result.pid === 'number' && result.pid > 0 ? result.pid : null
        this.initialCwds.set(sessionId, effectiveCwd)
      }
    } else if (
      !historyRecovery.identityChanged &&
      !result.isNew &&
      result.historySeeded === false
    ) {
      restoreInfo = await context.detectColdRestore()
      historySeedSegments = restoreInfo ? getRecoveredHistorySeedSegments(restoreInfo) : null
    }

    const wasAlreadyManaged = this.activeSessionIds.has(sessionId)
    this.activeSessionIds.add(sessionId)
    const providerSequence = providerSequenceFromCreateOrAttach(result)

    if (restoreInfo && (result.isNew || result.historySeeded === false)) {
      const coldRestore = this.buildColdRestorePayload(restoreInfo)
      const canReanchorHistory =
        !historySeedSegments || historySeedSegments.length === 0 || result.historySeeded === true
      // Preserve existing recovery bytes until the revived generation can safely re-anchor history.
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
          // The new generation has no checkpoint; discard any cooldown inherited from before the crash.
          this.lastFullCheckpointAt.delete(sessionId)
        } else {
          // Keep old recovery files if the daemon cannot include them; a fresh-only checkpoint would erase them.
          this.historyManager.suspendSession(sessionId, recoveryFreeze)
        }
      }
      if (coldRestore) {
        this.coldRestoreCache.set(sessionId, coldRestore)
        return finalizeSpawnResult({
          id: sessionId,
          ...daemonSpawnResultIdentity(result),
          pid,
          coldRestore,
          ...(providerWslDistro !== undefined ? { wslDistro: providerWslDistro } : {}),
          ...(providerSequence ? { providerSequence } : {}),
          ...(!result.isNew ? { isReattach: true } : {})
        })
      }
      return finalizeSpawnResult({
        id: sessionId,
        ...daemonSpawnResultIdentity(result),
        pid,
        ...(providerWslDistro !== undefined ? { wslDistro: providerWslDistro } : {}),
        ...(providerSequence ? { providerSequence } : {})
      })
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
      // The daemon retains seed failure across adapters; do not promote a fresh-only snapshot after restart.
      this.historyManager.suspendSession(
        sessionId,
        takeHistoryRecoveryFreeze(historyRecovery, sessionId)
      )
    } else if (this.historyManager && !historyRecovery.identityChanged) {
      // Register a writer without deleting the still-authoritative checkpoint on warm reattach.
      this.historyManager.registerWriter(
        sessionId,
        takeHistoryRecoveryFreeze(historyRecovery, sessionId)
      )
      if (!wasAlreadyManaged) {
        // Prior adapters may have drained unpersisted records; prove continuity on the first compaction.
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        this.sessionsNeedingContinuityCheckpoint.add(sessionId)
        this.lastFullCheckpointAt.delete(sessionId)
      }
    }

    if (result.isNew || !result.snapshot) {
      return finalizeSpawnResult({
        id: sessionId,
        ...daemonSpawnResultIdentity(result),
        pid,
        ...(providerWslDistro !== undefined ? { wslDistro: providerWslDistro } : {}),
        ...(providerSequence ? { providerSequence } : {}),
        ...(!result.isNew ? { isReattach: true } : {})
      })
    }

    const reattachSnapshot = await this.overlayDurableRestoreSnapshot(sessionId, result.snapshot)
    const reattachProviderSequence =
      typeof reattachSnapshot.outputSequence === 'number'
        ? { value: reattachSnapshot.outputSequence, generation: 'continued' as const }
        : providerSequence
    const isAltScreen = reattachSnapshot.modes.alternateScreen
    const snapshotPrefix = reattachSnapshot.scrollbackAnsi + reattachSnapshot.rehydrateSequences
    const snapshotFrame = reattachSnapshot.snapshotAnsi
    // Reassert kitty flags after payload screen switches; carry known zero separately from unknown.
    const kittyKeyboardFlags = parseTerminalKittyKeyboardFlags(
      reattachSnapshot.modes.kittyKeyboardFlags
    )
    return finalizeSpawnResult({
      id: sessionId,
      ...daemonSpawnResultIdentity(result),
      pid,
      ...(providerWslDistro !== undefined ? { wslDistro: providerWslDistro } : {}),
      snapshot: snapshotPrefix + snapshotFrame,
      snapshotCols: reattachSnapshot.cols,
      snapshotRows: reattachSnapshot.rows,
      // Only alt frames need a separate restore; normal history can replay at its captured grid.
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
      // Snapshot ANSI lacks title frames; carry the title separately across relaunch.
      ...(reattachSnapshot.lastTitle ? { lastTitle: reattachSnapshot.lastTitle } : {}),
      // Replay the mid-escape tail after renderer reset so split escapes do not render literally.
      ...(reattachSnapshot.pendingEscapeTailAnsi
        ? { pendingEscapeTailAnsi: reattachSnapshot.pendingEscapeTailAnsi }
        : {})
    })
  }
}
