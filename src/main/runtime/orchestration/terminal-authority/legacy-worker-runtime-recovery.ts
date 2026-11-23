import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'
import { listWorkerRestartOffers } from '../db/worker-dispatch/worker-restart-resume'
import type { LegacyWorkerTerminalRecoveryPlan } from './release/orchestration-legacy-worker-terminal-recovery'
import type { LegacyWorkerTerminalRecoveryResult } from './structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import type { OrcaRuntimeWithAgentPromptRequestCorrelation as PromptCorrelation } from '../../terminal/input/orca-runtime-agent-prompt-request-correlation'
import { RuntimeWorkspaceSessionFlush } from '../../workspaces/session-hosts/runtime-workspace-session-flush'
import { StartupWorkerAuthorityRestore } from './startup-worker-authority-restore'
import type { OrcaRuntimeWithGetStructuredAgentSessionCreateSupport as StructuredSessionStartup } from '../../session-tabs/chat/structured-session-create-support'
import {
  StructuredAgentSessionLaunchContinuationOnce,
  structuredAgentSessionLaunchContinuationDeps
} from '../../agent-session/lifecycle/structured-agent-session-launch-continuation'
import {
  getStructuredAgentSessionHost,
  onStructuredAgentSessionHostChanged
} from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  reportDismissedCutWorkers,
  reportWorkerStopsAcrossRestart
} from '../workers/turn-stops/restart-worker-stop-report'
import { reconsiderRestAfterWait } from '../workers/turn-stops/worker-presence-report'
import type { TerminalWorkerTurnStops } from '../workers/turn-stops/terminal-worker-turn-stops'
import { agentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import { isOrcaSessionId } from '../../../../shared/agent-session/identity/orca-session-address'
import { canonicalOrcaSessionId } from '../addressing/session-lineage/canonical-orca-session-id'
import { settleRestartCutStart } from '../workers/turn-stops/awaiting-worker-start-report'
import {
  observeUnconfirmedWorkerStart,
  observeWithheldRestartContinue,
  type UnconfirmedWorkerStart
} from '../workers/turn-stops/unconfirmed-worker-start'
import { readWorkerPresence } from '../db/worker-presence/worker-presence-store'
import { redactWorkerTerminalView } from './views/worker-terminal-redaction'
import {
  describeUnconfirmedStartEvidence,
  describeWithheldContinue,
  SUBMIT_WITHHELD_STAGE,
  WITHHELD_AFTER_RESTART_EVIDENCE,
  type UnconfirmedStartDelivery
} from '../workers/turn-stops/unconfirmed-start-evidence'
import { isTerminalHandle } from '../../../../shared/terminal/terminal-handle-prefix'
import type { RuntimeTerminalPromptSubmitHold } from '../../../../shared/terminal/runtime/runtime-terminal-send-contract'
import { isStructuredWorkerHandle } from '../../../../shared/orchestration/workers/structured-worker-handle'
import { redriveWaitingChatMail } from '../mailbox/structured-mail/structured-chat-mail-restart-redrive'

export abstract class LegacyWorkerRuntimeRecovery extends RuntimeWorkspaceSessionFlush {
  protected abstract getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>>
  readonly startupWorkerAuthority = new StartupWorkerAuthorityRestore()
  /** Settles once this start has continued (or offered) what the last run cut off. */
  readonly structuredAgentSessionLaunchContinuation =
    new StructuredAgentSessionLaunchContinuationOnce()
  abstract prepareStructuredAgentSessionStartupRestoration(
    ...args: Parameters<StructuredSessionStartup['prepareStructuredAgentSessionStartupRestoration']>
  ): ReturnType<StructuredSessionStartup['prepareStructuredAgentSessionStartupRestoration']>
  abstract readTerminalAgentPromptAftermath(
    ...args: Parameters<PromptCorrelation['readTerminalAgentPromptAftermath']>
  ): ReturnType<PromptCorrelation['readTerminalAgentPromptAftermath']>

  /** Continues after startup restoration, whichever path ran it, and off the startup path. A failed
   *  restoration only lets waiters go on, so a retry that reconciles leases still continues. */
  protected continueAfterStartupRestoration(restoration: Promise<void>): Promise<void> {
    const launch = this.structuredAgentSessionLaunchContinuation
    return restoration.then(
      () =>
        launch.start(
          structuredAgentSessionLaunchContinuationDeps(
            getStructuredAgentSessionHost(),
            () => this.store?.getSettings?.()?.nativeChatResumeWorkOnRestart === true
          )
        ),
      (error: unknown) => {
        launch.start(undefined, { retryable: true })
        throw error
      }
    )
  }

  abstract redriveStructuredSessionMail(sessionId: string): void

  protected abstract readonly terminalWorkerTurnStops: Pick<
    TerminalWorkerTurnStops,
    'reportRestingPane' | 'backgroundWaits'
  >

  private restartWorkerStopReport: Promise<void> | null = null
  private readonly dismissalWatched = new WeakSet<object>()

  /** Once per start, after restored terminal authority: tell coordinators about workers that
   *  stopped while Orca was down, or that this start did not continue. */
  reportWorkerStopsAcrossRestartOnce(): Promise<void> {
    // Restored terminals are placed: workers held for a restart resume reopen now.
    this.terminalWorkerRestartResume.settleStartup()
    // Workers still offered from before this start are shown with the cut chats, as their offers are.
    try {
      const db = this.getExistingOrchestrationDb()
      if (db && listWorkerRestartOffers(db).length > 0) {
        this.notifier?.restartOffersChanged?.()
      }
    } catch (error) {
      console.warn('[orchestration] reading offered terminal workers failed', error)
    }
    if (this.restartWorkerStopReport === null) {
      // A restoration retried after a failure passes over what it continued and left, again.
      this.structuredAgentSessionLaunchContinuation.onRetried(
        (settled) => void this.reportWorkerStopsAcrossRestart(Promise.resolve(settled))
      )
      // A worker's wait for mail that ended empty no longer holds back its rest.
      this.messageWaiters.onWaitEnded((mailbox) =>
        reconsiderRestAfterWait(mailbox, this.workerTurnStopReportDeps)
      )
      // Startup swallows a refused host install; the later install makes custody readable again.
      onStructuredAgentSessionHostChanged(() => {
        if (this.chatMailRedrivenOnce && getStructuredAgentSessionHost()) {
          void this.redriveWaitingChatMail()
        }
      })
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
        armBackgroundWait: (dispatchId) =>
          this.terminalWorkerTurnStops.backgroundWaits.arm(db, dispatchId),
        resuming: (dispatchId) => this.terminalWorkerRestartResume.isResumingThisStart(dispatchId),
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
    await this.redriveWaitingChatMail()
  }

  private chatMailRedrivenOnce = false

  private async redriveWaitingChatMail(): Promise<void> {
    this.chatMailRedrivenOnce = true
    try {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        return
      }
      const started = performance.now()
      const owedMail = this.getExistingOrchestrationDb()?.getStructuredMailSendSessions() ?? []
      const woken = await redriveWaitingChatMail(host, owedMail, (sessionId) =>
        this.redriveStructuredSessionMail(sessionId)
      )
      if (owedMail.length > 0) {
        console.info('[orchestration] restart mail pass', {
          owedMail: owedMail.length,
          woken,
          ms: Math.round(performance.now() - started)
        })
      }
    } catch (error: unknown) {
      console.warn('[orchestration] waking chat mail after a restart failed', error)
    }
  }

  /** Tells the coordinator once about a start whose turn Orca never saw begin, live or after a
   *  restart; a terminal's screen shows whether its brief still waits in the prompt. */
  async reportUnconfirmedWorkerStart(
    dispatchId: string,
    delivery?: UnconfirmedStartDelivery
  ): Promise<void> {
    const db = this.getExistingOrchestrationDb()
    // A paired server's start is settled by federation reconcile, not here.
    if (!db || db.getFederatedDispatch(dispatchId)) {
      return
    }
    const worker = settleRestartCutStart(db, dispatchId, this)
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
            screen: await this.readUnsubmittedWorkerScreen(handle),
            ...(delivery
              ? {
                  evidence: describeUnconfirmedStartEvidence(
                    delivery,
                    delivery.prompt
                      ? this.readTerminalAgentPromptAftermath(handle, delivery.prompt)
                      : null
                  )
                }
              : worker.stage === SUBMIT_WITHHELD_STAGE
                ? { evidence: WITHHELD_AFTER_RESTART_EVIDENCE }
                : {})
          }
        : { surface: 'chat' }
    observeUnconfirmedWorkerStart(db, dispatchId, start, this.workerTurnStopReportDeps)
  }

  /** Tells the coordinator once that a resumed worker's continue prompt waits unsent behind a
   *  dialog or someone's typing, as a start's withheld brief is told. */
  async reportWithheldRestartContinue(
    dispatchId: string,
    handle: string,
    hold: RuntimeTerminalPromptSubmitHold
  ): Promise<void> {
    const db = this.getExistingOrchestrationDb()
    if (!db) {
      return
    }
    const before = readWorkerPresence(db, dispatchId)
    const screen = await this.readUnsubmittedWorkerScreen(handle)
    const after = readWorkerPresence(db, dispatchId)
    // Submitted and seen to work or rest during the read: the alert would be stale.
    if (after?.presence !== before?.presence || after?.generation !== before?.generation) {
      return
    }
    observeWithheldRestartContinue(
      db,
      dispatchId,
      { screen, evidence: describeWithheldContinue(hold) },
      this.workerTurnStopReportDeps
    )
  }

  private readUnsubmittedWorkerScreen(handle: string): Promise<string | undefined> {
    return this.readTerminal(handle, { screen: true, limit: 15 })
      .then((view) => {
        const { tail, draft } = redactWorkerTerminalView(view)
        // A held paste shows as a bare prompt; the composer's draft says what waits there.
        return [...tail, ...(draft ? [`Text waiting in its prompt: ${draft}`] : [])].join('\n')
      })
      .catch(() => undefined)
  }

  protected holdLostWorkerForRestartResume(
    candidate: LegacyWorkerTerminalRecoveryPlan['candidates'][number]
  ): boolean {
    return this.terminalWorkerRestartResume.holdForReopen(candidate.dispatchId, () =>
      this.failLostRestartWorker(candidate.dispatchId)
    )
  }

  protected failLostRestartWorker(dispatchId: string): void {
    const dispatch = this.getExistingOrchestrationDb()?.getDispatchContextById(dispatchId)
    const incarnation = dispatch?.process_incarnation ?? ''
    const worker = {
      dispatchId,
      terminalHandle: dispatch?.assignee_handle ?? '',
      ptyId: incarnation.slice(0, Math.max(0, incarnation.lastIndexOf(':')))
    }
    // A failed close re-enters the sweep: its claim is spent, so the sweep's own retry owns it.
    if (!this.legacyWorkerRecoveryPersistence.reconcileMissing(worker, this.lostWorkerReport)) {
      void this.reconcileLegacyWorkerTerminals().catch(() => undefined)
    }
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
