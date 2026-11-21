import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'
import type { LegacyWorkerTerminalRecoveryPlan } from './release/orchestration-legacy-worker-terminal-recovery'
import type { LegacyWorkerTerminalRecoveryResult } from './structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import { RuntimeWorkspaceSessionFlush } from '../../workspaces/session-hosts/runtime-workspace-session-flush'
import { StartupWorkerAuthorityRestore } from './startup-worker-authority-restore'
import type { OrcaRuntimeWithGetStructuredAgentSessionCreateSupport as StructuredSessionStartup } from '../../session-tabs/chat/structured-session-create-support'
import {
  StructuredAgentSessionLaunchContinuationOnce,
  structuredAgentSessionLaunchContinuationDeps
} from '../../agent-session/lifecycle/structured-agent-session-launch-continuation'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  reportDismissedCutWorkers,
  reportWorkerStopsAcrossRestart
} from '../workers/turn-stops/restart-worker-stop-report'
import { reconsiderRestAfterWait } from '../workers/turn-stops/worker-presence-report'
import type { TerminalWorkerTurnStops } from '../workers/turn-stops/terminal-worker-turn-stops'
import { agentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import { isOrcaSessionId } from '../../../../shared/agent-session/identity/orca-session-address'
import { canonicalOrcaSessionId } from '../addressing/session-lineage/canonical-orca-session-id'
import { settleRestartCutWorkerStart } from '../db/worker-dispatch/restart-cut-worker-start'
import {
  observeUnconfirmedWorkerStart,
  type UnconfirmedWorkerStart
} from '../workers/turn-stops/unconfirmed-worker-start'
import { redactWorkerTerminalView } from './views/worker-terminal-redaction'
import { isTerminalHandle } from '../../../../shared/terminal/terminal-handle-prefix'
import { isStructuredWorkerHandle } from '../../../../shared/orchestration/workers/structured-worker-handle'

export abstract class LegacyWorkerRuntimeRecovery extends RuntimeWorkspaceSessionFlush {
  protected abstract getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>>
  readonly startupWorkerAuthority = new StartupWorkerAuthorityRestore()
  /** Settles once this start has continued (or offered) what the last run cut off. */
  readonly structuredAgentSessionLaunchContinuation =
    new StructuredAgentSessionLaunchContinuationOnce()
  abstract prepareStructuredAgentSessionStartupRestoration(
    ...args: Parameters<StructuredSessionStartup['prepareStructuredAgentSessionStartupRestoration']>
  ): ReturnType<StructuredSessionStartup['prepareStructuredAgentSessionStartupRestoration']>

  /** Continues after startup restoration, whichever path ran it, and off the startup path. A failed
   *  restoration only lets waiters go on, so a retry that reconciles leases still continues. */
  protected continueAfterStartupRestoration(restoration: Promise<void>): Promise<void> {
    const start = (restored: boolean) =>
      this.structuredAgentSessionLaunchContinuation.start(
        restored
          ? structuredAgentSessionLaunchContinuationDeps(
              getStructuredAgentSessionHost(),
              () => this.store?.getSettings?.()?.nativeChatResumeWorkOnRestart === true
            )
          : undefined
      )
    return restoration.then(
      () => start(true),
      (error: unknown) => {
        start(false)
        throw error
      }
    )
  }

  protected abstract readonly terminalWorkerTurnStops: Pick<
    TerminalWorkerTurnStops,
    'reportRestingPane'
  >

  private restartWorkerStopReport: Promise<void> | null = null
  private readonly dismissalWatched = new WeakSet<object>()

  /** Once per start, after restored terminal authority: tell coordinators about workers that
   *  stopped while Orca was down, or that this start did not continue. */
  reportWorkerStopsAcrossRestartOnce(): Promise<void> {
    if (this.restartWorkerStopReport === null) {
      // A restoration retried after a failure passes over what it continued and left, again.
      this.structuredAgentSessionLaunchContinuation.onRetried(
        (settled) => void this.reportWorkerStopsAcrossRestart(Promise.resolve(settled))
      )
      // A worker's wait for mail that ended empty no longer holds back its rest.
      this.messageWaiters.onWaitEnded((mailbox) =>
        reconsiderRestAfterWait(mailbox, this.workerTurnStopReportDeps)
      )
    }
    this.restartWorkerStopReport ??= this.reportWorkerStopsAcrossRestart(
      this.structuredAgentSessionLaunchContinuation.done
    )
    return this.restartWorkerStopReport
  }

  private async reportWorkerStopsAcrossRestart(
    launch: Promise<{ cutByLastRun: ReadonlySet<string> }>
  ): Promise<void> {
    try {
      // Continued chats are working again, and replayed hooks have been probed once.
      const { cutByLastRun } = await launch
      const host = getStructuredAgentSessionHost()
      if (host && !this.dismissalWatched.has(host)) {
        this.dismissalWatched.add(host)
        host.restartResume.onDismissed((dismissed) => {
          const db = this.getExistingOrchestrationDb()
          if (db) {
            reportDismissedCutWorkers(
              {
                db,
                reportDeps: this.workerTurnStopReportDeps,
                lastOutput: (sessionId) => host.readStatusSummary(sessionId)?.lastAssistantMessage
              },
              dismissed
            )
          }
        })
      }
      await agentHookServer.whenRestoredOwnersChecked()
      const db = this.getExistingOrchestrationDb()
      if (!db) {
        return
      }
      await reportWorkerStopsAcrossRestart({
        db,
        reportDeps: this.workerTurnStopReportDeps,
        reportRestingPane: (paneKey) => this.terminalWorkerTurnStops.reportRestingPane(paneKey),
        reportUnconfirmedStart: (dispatchId) => this.reportUnconfirmedWorkerStart(dispatchId),
        chats: host
          ? {
              cutByLastRun,
              lineageRoot: (sessionId) =>
                isOrcaSessionId(sessionId) ? canonicalOrcaSessionId(sessionId) : sessionId,
              open: (sessionId) => host.revealSession(sessionId).catch(() => null),
              lastOutput: (sessionId) => host.readStatusSummary(sessionId)?.lastAssistantMessage,
              offeredCuts: () => host.restartResume.offeredCuts(),
              cutOf: (sessionId, offered) => host.restartResume.cutOf(sessionId, offered)
            }
          : null
      })
    } catch (error: unknown) {
      console.warn('[orchestration] reporting workers stopped across a restart failed', error)
    }
  }

  /** Tells the coordinator once about a start whose turn Orca never saw begin, live or after a
   *  restart; a terminal's screen shows whether its brief still waits in the prompt. */
  async reportUnconfirmedWorkerStart(dispatchId: string): Promise<void> {
    const db = this.getExistingOrchestrationDb()
    // A paired server's start is settled by federation reconcile, not here.
    if (!db || db.getFederatedDispatch(dispatchId)) {
      return
    }
    const worker = settleRestartCutWorkerStart(db, dispatchId, this.getRuntimeId())
    if (worker?.state !== 'start_unknown') {
      return
    }
    const dispatch = db.getDispatchContextById(dispatchId)
    // A chat's Dispatch names its session; only a terminal worker has a screen to read.
    const handle = dispatch?.assignee_orca_session_id ? null : dispatch?.assignee_handle
    const start: UnconfirmedWorkerStart =
      handle && isTerminalHandle(handle) && !isStructuredWorkerHandle(handle)
        ? {
            surface: 'terminal',
            screen: await this.readTerminal(handle, { screen: true, limit: 15 })
              .then((view) => {
                const { tail, draft } = redactWorkerTerminalView(view)
                // A held paste shows as a bare prompt; the composer's draft says what waits there.
                return [...tail, ...(draft ? [`Text waiting in its prompt: ${draft}`] : [])].join(
                  '\n'
                )
              })
              .catch(() => undefined)
          }
        : { surface: 'chat' }
    observeUnconfirmedWorkerStart(db, dispatchId, start, this.workerTurnStopReportDeps)
  }

  async reconcileLegacyWorkerTerminals(
    options: { connectionId?: string; materializeRenderer?: boolean } = {}
  ): Promise<LegacyWorkerTerminalRecoveryResult> {
    return this.legacyWorkerRecovery.reconcile(options)
  }

  stopLegacyWorkerTerminalRecovery(): Promise<void> {
    return this.legacyWorkerRecovery.stop()
  }

  protected updateLegacyWorkerTerminalRecoveryRetry(
    plan: LegacyWorkerTerminalRecoveryPlan,
    deferredDispatchIds: ReadonlySet<string>,
    options: { connectionId?: string; materializeRenderer?: boolean }
  ): void {
    this.legacyWorkerRecovery.updateRetry(plan, deferredDispatchIds, options)
  }

  async refreshRestoredOrchestrationAuthority(connectionId: string | null = null): Promise<void> {
    if (connectionId === null) {
      // Why: until restart leases are reconciled, a chat worker that died with the last run reads as unverifiable.
      await this.prepareStructuredAgentSessionStartupRestoration().catch((error: unknown) => {
        console.warn('[orchestration] chat worker restart reconcile failed', error)
      })
      if (!this.canRecoverPersistentLocalPtysFn()) {
        return
      }
    }
    const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
      [...(await this.getResolvedWorktreeMap()).values()],
      null,
      undefined,
      connectionId
    )
    if (!inventory) {
      throw new Error('terminal_liveness_unavailable')
    }
  }
}
