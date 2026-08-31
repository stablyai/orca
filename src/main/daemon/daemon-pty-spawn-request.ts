import type { ColdRestorePayload } from './cold-restore-payload-cache'
import type { DaemonAuditObservation } from './daemon-audit-classifier'
import {
  DaemonPtyRuntimeState,
  type HistoryRecoveryContext,
  type PendingDaemonSpawnOperation,
  type SnapshotCheckpointResult
} from './daemon-pty-runtime-state'
import { isDaemonGoneError } from './daemon-endpoint-errors'
import { HISTORY_SEED_TRANSFER_PROTOCOL_VERSION } from './daemon-protocol-version'
import type { ColdRestoreInfo } from './history-reader'
import { NdjsonLineTooLongError } from './ndjson'
import {
  iterateTerminalHistorySeedChunks,
  measureTerminalHistorySeed,
  TERMINAL_HISTORY_INLINE_SEED_CODE_UNITS
} from './terminal-history-seed-chunks'
import type { CreateOrAttachResult, GetSnapshotResult } from './types'
import type { PtySpawnOptions, PtySpawnResult } from '../providers/types'

export type DaemonPtySpawnContext = {
  opts: PtySpawnOptions
  operation: PendingDaemonSpawnOperation
  historyRecovery: HistoryRecoveryContext
  requestedSessionId: string
  attachOnly: boolean
  emulateLegacyAttachOnly: boolean
  sessionId: string
  wslDistro: string | undefined
  restoreInfo: ColdRestoreInfo | null
  restoreSkippedForLiveSession: boolean
  effectiveCwd: string | undefined
  effectiveCols: number
  effectiveRows: number
  shellReadySupported: boolean
  shellReadyTimeoutMs: number | undefined
  historySeedSegments: readonly string[] | null
  detectColdRestore(options?: { ignoreCleanEnd?: boolean }): Promise<ColdRestoreInfo | null>
}

export abstract class DaemonPtySpawnRequest extends DaemonPtyRuntimeState {
  protected abstract takeSnapshotAndCheckpoint(
    sessionId: string,
    opts: {
      teardown: boolean
      forceLiveSnapshot?: boolean
      requireContinuityProof?: boolean
    }
  ): Promise<SnapshotCheckpointResult>
  protected abstract markSessionDirty(sessionId: string): void
  protected abstract writeSessionCheckpoint(
    sessionId: string,
    opts: { final: boolean; teardown: boolean }
  ): Promise<'done' | 'deferred'>
  protected abstract releasePendingRespawnAdoptionLease(): void
  protected abstract setupEventRouting(): void
  protected abstract scheduleCheckpointTimer(): void
  protected abstract stopCheckpointTimer(): void
  protected abstract stopCheckpointTimerIfIdle(): void
  protected abstract recordAuthenticatedIdentity(): void
  protected abstract runExclusiveCheckpoint(
    operation: () => Promise<void>,
    options?: { rescheduleDirty?: boolean; callerDeadlineMs?: number }
  ): Promise<boolean>
  protected abstract checkpointAllSessions(): Promise<void>
  protected abstract ensureConnected(deadlineMs?: number): Promise<void>
  protected abstract withHistorySpawnLock<T>(
    sessionId: string,
    operation: () => Promise<T>
  ): Promise<T>
  protected abstract clearSessionAwaitingDaemonRecovery(sessionId: string): void
  protected abstract reconnectAfterWriteFailure(): void
  protected abstract checkpointSessions(
    sessionIds: Iterable<string>,
    opts?: { final?: boolean; teardown?: boolean }
  ): Promise<Set<string>>
  protected abstract publishAuditObservation(observation: DaemonAuditObservation): void
  protected abstract isRetiredEndpointTokenMissing(): boolean
  protected abstract withDaemonRetry<T>(fn: () => Promise<T>): Promise<T>
  protected abstract replaceUnhealthyMacResolverDaemonBeforeNewPty(): Promise<void>
  protected abstract replaceStaleBundleDaemonBeforeNewPty(): Promise<void>
  protected abstract replaceSeveredMacTccDaemonBeforeNewPty(): Promise<void>
  abstract setPtyBackgrounded(id: string, background: boolean): void
  abstract getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null>
  protected abstract resultForExitBeforeSpawnReply(
    sessionId: string,
    result: CreateOrAttachResult,
    operation: PendingDaemonSpawnOperation
  ): PtySpawnResult | null
  protected abstract buildColdRestorePayload(
    restoreInfo: ColdRestoreInfo
  ): ColdRestorePayload | null
  protected abstract overlayDurableRestoreSnapshot(
    sessionId: string,
    liveSnapshot: NonNullable<GetSnapshotResult['snapshot']>,
    scrollbackRows?: number
  ): Promise<NonNullable<GetSnapshotResult['snapshot']>>

  protected async createOrAttachSpawn(
    context: DaemonPtySpawnContext,
    historySeedSegments: readonly string[] | null
  ): Promise<CreateOrAttachResult> {
    const requestCreateOrAttach = (
      historySeed: string | undefined,
      historySeedTransferId: string | undefined
    ) => {
      const { opts } = context
      if (opts.signal?.aborted) {
        throw new Error('client_disconnected')
      }
      const payload = {
        sessionId: context.sessionId,
        cols: context.effectiveCols,
        rows: context.effectiveRows,
        cwd: context.attachOnly ? undefined : context.effectiveCwd,
        env: context.attachOnly ? undefined : opts.env,
        envToDelete: context.attachOnly ? undefined : opts.envToDelete,
        command: context.attachOnly ? undefined : opts.command,
        startupCommandDelivery: context.attachOnly ? undefined : opts.startupCommandDelivery,
        launchAgent: context.attachOnly ? undefined : opts.launchAgent,
        ...(context.attachOnly && !context.emulateLegacyAttachOnly ? { attachOnly: true } : {}),
        shellOverride: context.attachOnly ? undefined : opts.shellOverride,
        terminalWindowsWslDistro: context.attachOnly ? undefined : opts.terminalWindowsWslDistro,
        terminalWindowsPowerShellImplementation: context.attachOnly
          ? undefined
          : opts.terminalWindowsPowerShellImplementation,
        shellReadySupported: context.attachOnly ? false : context.shellReadySupported,
        ...(!context.attachOnly && context.shellReadyTimeoutMs !== undefined
          ? { shellReadyTimeoutMs: context.shellReadyTimeoutMs }
          : {}),
        ...(historySeed ? { historySeed } : {}),
        ...(historySeedTransferId ? { historySeedTransferId } : {}),
        ...(this.supportsStartupIngress && !context.attachOnly && opts.startupIngress
          ? { startupIngress: opts.startupIngress }
          : {}),
        ...(!context.attachOnly && opts.agentSessionEnsure
          ? { agentSessionEnsure: opts.agentSessionEnsure }
          : {})
      }
      return opts.signal
        ? this.client.request<CreateOrAttachResult>(
            'createOrAttach',
            payload,
            undefined,
            opts.signal
          )
        : this.client.request<CreateOrAttachResult>('createOrAttach', payload)
    }

    let historySeedUnavailable = false
    const deliverSeedAndCreate = async (): Promise<CreateOrAttachResult> => {
      if (!historySeedSegments || historySeedSegments.length === 0) {
        return requestCreateOrAttach(undefined, undefined)
      }
      const metrics = measureTerminalHistorySeed(historySeedSegments)
      if (metrics.codeUnits <= TERMINAL_HISTORY_INLINE_SEED_CODE_UNITS) {
        try {
          return await requestCreateOrAttach(historySeedSegments.join(''), undefined)
        } catch (error) {
          if (!(error instanceof NdjsonLineTooLongError)) {
            throw error
          }
          historySeedUnavailable = true
          return requestCreateOrAttach(undefined, undefined)
        }
      }
      if (this.protocolVersion < HISTORY_SEED_TRANSFER_PROTOCOL_VERSION) {
        historySeedUnavailable = true
        return requestCreateOrAttach(undefined, undefined)
      }

      let transferId: string | undefined
      try {
        const started = await this.client.request<{ transferId: string }>(
          'startHistorySeedTransfer',
          metrics
        )
        transferId = started.transferId
        let index = 0
        for (const data of iterateTerminalHistorySeedChunks(historySeedSegments)) {
          await this.client.request('appendHistorySeedTransfer', { transferId, index, data })
          index += 1
        }
        await this.client.request('finishHistorySeedTransfer', { transferId })
      } catch (error) {
        if (transferId) {
          await this.client.request('abortHistorySeedTransfer', { transferId }).catch(() => {})
        }
        if (isDaemonGoneError(error)) {
          throw error
        }
        historySeedUnavailable = true
        return requestCreateOrAttach(undefined, undefined)
      }
      return requestCreateOrAttach(undefined, transferId)
    }
    const result = await deliverSeedAndCreate()
    return historySeedUnavailable && result.historySeeded === undefined
      ? { ...result, historySeeded: false }
      : result
  }
}
