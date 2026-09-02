import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { shouldUseShellReadyStartupDelivery } from '../../shared/codex-startup-delivery'
import type {
  HistoryRecoveryContext,
  PendingDaemonSpawnOperation
} from './daemon-pty-runtime-state'
import { trackDaemonPtyCwdDeniedIfDiverged } from './daemon-adoption-telemetry-event'
import { STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION } from './daemon-protocol-version'
import { TerminalKilledError } from './daemon-pty-lifecycle-errors'
import { DaemonPtySpawnResult } from './daemon-pty-spawn-result'
import type { DaemonPtySpawnContext } from './daemon-pty-spawn-request'
import type { ColdRestoreInfo } from './history-reader'
import { mintPtySessionId } from './pty-session-id'
import { CODEX_SHELL_READY_TIMEOUT_MS } from './session-shell-ready-barrier'
import { supportsPtyStartupBarrier } from './shell-ready'
import { getRecoveredHistorySeedSegments } from './terminal-history-seed-segments'
import { AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION, type CreateOrAttachResult } from './types'
import { normalizeWslColdRestoreCwd } from './wsl-cold-restore-cwd'
import { resolveWslSessionContext } from './wsl-session-context'
import { resolveSafePtyDefaultCwd } from '../providers/pty-default-cwd'
import { resolveUnixShellPath } from '../providers/local-pty-utils'
import type { PtySpawnOptions, PtySpawnResult } from '../providers/types'
import { injectHistoryEnv, injectWslFishHistoryEnv, logHistoryInjection } from '../terminal-history'
import { addWslEnvKeys } from '../wsl-env'

export abstract class DaemonPtySessionSpawn extends DaemonPtySpawnResult {
  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    const spawnOpts = this.withHistoryIsolation(opts)
    const sessionId = spawnOpts.sessionId ?? mintPtySessionId(spawnOpts.worktreeId)
    const operation: PendingDaemonSpawnOperation = {
      exitsBySessionId: new Map(),
      ignoredExitIncarnationIds: new Set<string>(),
      ignoreNextExit: false
    }
    const operations = this.pendingSpawnOperationsBySessionId.get(sessionId) ?? new Set()
    operations.add(operation)
    this.pendingSpawnOperationsBySessionId.set(sessionId, operations)
    if (opts.agentSessionEnsure) {
      this.pendingClaimSpawnOperations.add(operation)
    }
    const historyRecovery: HistoryRecoveryContext = {
      freeze: null,
      unreadableSessionId: null,
      identityChanged: false
    }
    try {
      return await this.withHistorySpawnLock(sessionId, () =>
        this.withDaemonRetry(() =>
          this.doSpawn({ ...spawnOpts, sessionId }, operation, historyRecovery)
        )
      )
    } finally {
      if (historyRecovery.freeze) {
        this.historyManager?.abandonRecoveryFreeze(historyRecovery.freeze)
      }
      this.pendingClaimSpawnOperations.delete(operation)
      operations.delete(operation)
      if (operations.size === 0) {
        this.pendingSpawnOperationsBySessionId.delete(sessionId)
      }
    }
  }

  protected withHistoryIsolation(opts: PtySpawnOptions): PtySpawnOptions {
    const wslContext = resolveWslSessionContext({
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      shellOverride: opts.shellOverride,
      terminalWindowsWslDistro: opts.terminalWindowsWslDistro
    })
    if (
      opts.attachOnly === true ||
      (opts.sessionId !== undefined && opts.isNewSession !== true) ||
      !opts.worktreeId ||
      opts.historyIsolationEnabled !== true ||
      (process.platform === 'win32' && !wslContext)
    ) {
      return opts
    }
    const env = { ...opts.env }
    const preferredShell = wslContext
      ? 'bash'
      : opts.shellOverride || env.SHELL || process.env.SHELL || '/bin/zsh'
    const shellPath = resolveUnixShellPath(preferredShell)
    const historyArgs = [
      env,
      opts.worktreeId,
      shellPath,
      opts.cwd ?? resolveSafePtyDefaultCwd()
    ] as const
    const result = wslContext
      ? injectHistoryEnv(...historyArgs, { wslDistro: wslContext.distro })
      : injectHistoryEnv(...historyArgs)
    if (wslContext) {
      injectWslFishHistoryEnv(env, opts.worktreeId, wslContext.distro)
      addWslEnvKeys(env, ['HISTFILE', 'fish_history'])
    }
    logHistoryInjection(opts.worktreeId, result)
    return { ...opts, env }
  }

  protected async doSpawn(
    opts: PtySpawnOptions,
    operation: PendingDaemonSpawnOperation,
    historyRecovery: HistoryRecoveryContext
  ): Promise<PtySpawnResult> {
    if (
      opts.agentSessionEnsure &&
      this.protocolVersion < AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION
    ) {
      throw new Error('agent_session_claim_unavailable')
    }
    const requestedSessionId = opts.sessionId!
    // Why: v30 daemons survive upgrades; reject their accidental create result before publication.
    const attachOnly = opts.attachOnly === true
    const emulateLegacyAttachOnly =
      attachOnly && this.protocolVersion < STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION
    let sessionId = requestedSessionId
    let wslDistro = resolveWslSessionContext({
      cwd: opts.cwd,
      sessionId,
      shellOverride: opts.shellOverride,
      terminalWindowsWslDistro: opts.terminalWindowsWslDistro
    })?.distro
    let activeSpawnContext: DaemonPtySpawnContext | null = null
    const freezeHistory = async (): Promise<void> => {
      if (!this.historyManager) {
        return
      }
      const recoverySessionId = activeSpawnContext?.sessionId ?? sessionId
      if (historyRecovery.freeze?.sessionId === recoverySessionId) {
        return
      }
      if (historyRecovery.freeze) {
        this.historyManager.abandonRecoveryFreeze(historyRecovery.freeze)
      }
      historyRecovery.freeze = await this.historyManager.freezeForRecovery(recoverySessionId)
      historyRecovery.unreadableSessionId = null
    }
    const detectColdRestore = async (options?: {
      ignoreCleanEnd?: boolean
    }): Promise<ColdRestoreInfo | null> => {
      if (!this.historyReader) {
        return null
      }
      await freezeHistory()
      const recoverySessionId = activeSpawnContext?.sessionId ?? sessionId
      const recoveryWslDistro = activeSpawnContext?.wslDistro ?? wslDistro
      const detection = await this.historyReader.detectColdRestoreState(recoverySessionId, {
        ...options,
        wslDistro: recoveryWslDistro
      })
      if (detection.status === 'unreadable') {
        historyRecovery.unreadableSessionId = detection.sessionId
        return null
      }
      const restoreInfo = detection.status === 'restored' ? detection.restoreInfo : null
      if (detection.status === 'restored' && detection.hasUnreadableRecovery) {
        historyRecovery.unreadableSessionId = detection.sessionId
      }
      if (!restoreInfo) {
        return null
      }
      return {
        ...restoreInfo,
        cwd:
          normalizeWslColdRestoreCwd({
            recoveredCwd: restoreInfo.cwd,
            requestedCwd: opts.cwd ?? resolveSafePtyDefaultCwd(),
            wslDistro: recoveryWslDistro
          }) ?? ''
      }
    }

    if (this.killedSessionTombstones.has(sessionId)) {
      throw new TerminalKilledError(sessionId)
    }

    if (opts.isNewSession) {
      await this.replaceUnhealthyMacResolverDaemonBeforeNewPty()
      await this.replaceStaleBundleDaemonBeforeNewPty()
      await this.replaceSeveredMacTccDaemonBeforeNewPty()
    }

    await this.ensureConnected()
    // Why before createOrAttach: a preserved daemon may still think this session is backgrounded — from
    // a v19 that thins without a recoverable seq, or (#9993) from a pre-v29 that a previous desktop
    // handed 2031 scan authority to and can never retract it. Clear it before any bytes are attached.
    if (!this.canDelegateBackgroundToDaemon) {
      this.setPtyBackgrounded(sessionId, false)
    }

    // Why detect crash-recovery history before spawning: the revived shell should inherit the recovered cwd/dims, not the renderer's mount-time request.
    // Why probe aliveness first: detectColdRestore replays up to ~5MB on the main process, but a live session's snapshot supersedes disk, so the replay would be wasted.
    let restoreInfo: ColdRestoreInfo | null = null
    let restoreSkippedForLiveSession = false
    const historyProbe = opts.attachOnly
      ? undefined
      : this.historyReader?.probeRestorableHistory(sessionId)
    if (historyProbe && historyProbe.status !== 'none') {
      if ((await this.getAppliedSize(sessionId)) !== null) {
        restoreSkippedForLiveSession = true
        if (this.historyManager && !this.historyManager.hasWriter(sessionId)) {
          await detectColdRestore()
          restoreInfo = null
        }
      } else {
        restoreInfo = await detectColdRestore()
      }
    }
    let effectiveCwd = restoreInfo?.cwd ?? opts.cwd
    let effectiveCols = restoreInfo?.cols ?? opts.cols
    let effectiveRows = restoreInfo?.rows ?? opts.rows

    const shellReadySupported = opts.command ? supportsPtyStartupBarrier(opts.env ?? {}) : false
    const isCodexStartupCommand =
      recognizeAgentProcessFromCommandLine(opts.command)?.agent === 'codex'
    const shouldWaitForShellReady =
      isCodexStartupCommand &&
      shouldUseShellReadyStartupDelivery({
        command: opts.command,
        startupCommandDelivery: opts.startupCommandDelivery
      })
    const shellReadyTimeoutMs =
      shellReadySupported && isCodexStartupCommand && !shouldWaitForShellReady
        ? CODEX_SHELL_READY_TIMEOUT_MS
        : undefined

    const context: DaemonPtySpawnContext = {
      opts,
      operation,
      historyRecovery,
      requestedSessionId,
      attachOnly,
      emulateLegacyAttachOnly,
      sessionId,
      wslDistro,
      restoreInfo,
      restoreSkippedForLiveSession,
      effectiveCwd,
      effectiveCols,
      effectiveRows,
      shellReadySupported,
      shellReadyTimeoutMs,
      historySeedSegments: restoreInfo ? getRecoveredHistorySeedSegments(restoreInfo) : null,
      detectColdRestore
    }
    activeSpawnContext = context
    const result = await this.createOrAttachSpawn(context, context.historySeedSegments)
    if (result.isNew && !attachOnly) {
      trackDaemonPtyCwdDeniedIfDiverged(effectiveCwd, result.cwdReadableByDaemon, this.pidPath)
    }
    return this.finishSpawn(context, result)
  }

  protected resultForExitBeforeSpawnReply(
    sessionId: string,
    result: CreateOrAttachResult,
    operation: PendingDaemonSpawnOperation
  ): PtySpawnResult | null {
    const knownIncarnationId = this.sessionIncarnations.get(sessionId)
    const matchingExit = (operation.exitsBySessionId.get(sessionId) ?? []).find(
      (exit) =>
        !(exit.incarnationId && operation.ignoredExitIncarnationIds.has(exit.incarnationId)) &&
        ((exit.incarnationId === undefined &&
          result.incarnationId === undefined &&
          knownIncarnationId === undefined) ||
          (exit.incarnationId !== undefined &&
            result.incarnationId !== undefined &&
            exit.incarnationId === result.incarnationId))
    )
    if (!matchingExit) {
      return null
    }
    if (result.incarnationId) {
      this.sessionIncarnations.set(sessionId, result.incarnationId)
    }
    this.clearExitedSessionState(sessionId, matchingExit.code, result.incarnationId)
    // Why: stream exit can beat the control reply or post-reply recovery work; return proof without republishing dead state.
    const exitedResult: PtySpawnResult = {
      id: sessionId,
      exitedBeforeSpawnReply: true,
      ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
      ...(result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {}),
      ...(!result.isNew ? { isReattach: true } : {})
    }
    return exitedResult
  }

  didExitBeforeSpawnReply(result: PtySpawnResult): boolean {
    return result.exitedBeforeSpawnReply === true
  }
}
