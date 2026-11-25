import type { AutomationUsageClient } from '../../shared/backend/backend-service-contract'
import {
  requestAutomationDispatch,
  runAutomationRequestPrecheck
} from './dispatch/automation-dispatch-request'
import { AutomationDispatchCancelledError } from './dispatch/automation-dispatch-cancelled-error'
import type { Store } from '../persistence/loading-store/store'
import {
  isFinalAutomationRunStatus,
  type AutomationDispatchResult,
  type AutomationPrecheckResult,
  type AutomationRun
} from '../../shared/automations/history/automation-run'
import type { Automation } from '../../shared/automations/automation-definition'
import {
  captureLegacyRunTarget,
  resolveAutomationRunTarget,
  type AutomationRunTargetResult
} from './ownership/run-target-resolution'
import { writeAutomationRunUsage } from './run-history/run-usage-collection'
import type * as Launch from './launch/automation-launch'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import { clearAutomationDispatchTokens } from './ownership/dispatch-tokens'
import { AutomationRunCompletionWatcher } from './observation/run-completion-watcher'
import { createAutomationRunWriter, type AutomationRunWriter } from './run-history/run-writer'
import { reportAutomationScheduleDrift } from './dispatch/schedule-drift-report'
import {
  canDispatchTo,
  describeScheduledTickRefusal,
  recordRefusedAutomationRun
} from './dispatch/dispatch-refusal'
import type { RunTerminalRetention } from './terminal-retention/run-terminal-retention'
import { AutomationWakeGate } from './dispatch/automation-wake-settle'
import type {
  AutomationsChangedPayload,
  PublishAutomationsChanged
} from '../../shared/remote-runtime/session-graph/runtime-client-events'
import type { AutomationRunEvent } from '../../shared/automation-event-triggers'
import {
  latestAutomationEvent,
  runForEvent,
  type AutomationOnceEffects,
  type AutomationTriggerRunContext,
  type EventRunOptions
} from './automation-trigger-runs'
import { runDueAutomations } from './automation-due-runs'
import type { AutomationServiceOptions } from './automation-service-options'

const DEFAULT_TICK_MS = 60 * 1000

export class AutomationService {
  private readonly store: Store
  private readonly tickMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private evaluating = false
  private stopped = false
  private dispatchAbort = new AbortController()
  private readonly claudeUsage: AutomationUsageClient | null
  private readonly codexUsage: AutomationUsageClient | null
  private readonly allowRemoteHostScheduling: boolean
  private readonly terminalLauncher: Launch.AutomationTerminalLauncher | null
  private readonly botDispatcher: Launch.AutomationBotLauncher | null
  private readonly onRunRefused: ((automation: Automation, error: string) => void) | null
  private readonly chatDispatcher: Launch.AutomationLauncher | null
  private readonly automationLanes = new Map<string, Promise<void>>()
  /** Shares this service's lanes and tick; `drain` closes unused completed run terminals. */
  readonly runTerminalRetention: RunTerminalRetention | null
  /** A bot's waits: their cards in its Chat, their expiry and removal. */
  once: AutomationOnceEffects | null = null
  /** Other schedules on this tick, such as bots' Look around; called while the scheduler runs. */
  onTick: (() => void) | null = null
  private readonly publish: PublishAutomationsChanged | null
  private readonly runs: AutomationRunWriter
  private readonly prepareCodexRun: AutomationServiceOptions['prepareCodexRun']
  private readonly completionWatcher: AutomationRunCompletionWatcher | null
  /** Desktop automation traffic holds this lease to defer queued external probes. */
  externalProbePriority: (<T>(run: () => T) => T) | null = null
  readonly wakeGate = new AutomationWakeGate()

  constructor(store: Store, opts: AutomationServiceOptions = {}) {
    this.store = store
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS
    this.claudeUsage = opts.claudeUsage ?? null
    this.codexUsage = opts.codexUsage ?? null
    this.allowRemoteHostScheduling = opts.allowRemoteHostScheduling ?? false
    this.terminalLauncher = opts.terminalLauncher ?? null
    this.botDispatcher = opts.botDispatcher ?? null
    this.onRunRefused = opts.onRunRefused ?? null
    this.chatDispatcher = opts.chatDispatcher ?? null
    this.prepareCodexRun = opts.prepareCodexRun
    this.publish = opts.onAutomationsChanged ?? null
    this.runs = createAutomationRunWriter(store, this.publish)
    this.completionWatcher = opts.terminalObserver
      ? new AutomationRunCompletionWatcher({
          observer: opts.terminalObserver,
          readRun: (automationId, runId) =>
            this.store.listAutomationRuns(automationId).find((entry) => entry.id === runId) ?? null,
          markDispatchResult: (result) => this.markDispatchResult(result),
          isHostQuitting: opts.isHostQuitting
        })
      : null
    this.runTerminalRetention = opts.runTerminalRetention?.(this) ?? null
  }

  publishAutomationsChanged(payload: AutomationsChangedPayload = {}): void {
    this.publish?.(payload)
  }

  start(): void {
    if (this.timer) {
      return
    }
    this.stopped = false
    this.timer = setInterval(() => {
      this.onTick?.()
      void this.evaluateDueRuns()
      void this.runTerminalRetention?.sweep()
    }, this.tickMs)
    // Settles unclaimed pending rows before catch-up could claim one again.
    this.completionWatcher?.reconcileRetainedRuns(this.store.listAutomationRuns())
    reportAutomationScheduleDrift(this.store.listAutomations())
    if (this.availableLauncher()) {
      void this.evaluateDueRuns()
    }
  }

  stop(): void {
    this.stopped = true
    this.dispatchAbort.abort(
      new AutomationDispatchCancelledError('Orca stopped before this automation could launch.')
    )
    this.dispatchAbort = new AbortController()
    this.completionWatcher?.dispose()
    clearInterval(this.timer ?? undefined)
    this.timer = null
  }

  async runNow(automationId: string): Promise<AutomationRun> {
    const signal = this.dispatchAbort.signal
    const listed = this.store.listAutomations().find((entry) => entry.id === automationId)
    if (!listed) {
      throw new Error('Automation not found.')
    }
    const automation = captureLegacyRunTarget(this.store, listed, this.allowRemoteHostScheduling)
    const target = this.resolveTarget(automation)
    const event = latestAutomationEvent(this.store, automation)
    const run = await this.runs.createRun(automation, Date.now(), 'manual', event)
    // The saved pending row is the acknowledgement; the lane owns execution behind earlier launches.
    this.launchInLane(automation, run, target, signal)
    return run
  }

  /** Detached so due runs start together; every failure after createRun settles the row. */
  private launchInLane(
    automation: Automation,
    run: AutomationRun,
    target: AutomationRunTargetResult,
    signal: AbortSignal,
    afterCreate?: () => Promise<unknown>
  ): void {
    void (async () => {
      // A blocked lane must not defer the schedule advance.
      await afterCreate?.()
      await this.requestDispatch(automation, run, target, signal)
    })()
      .catch((error: unknown) => this.recordFailedLaunch(run, signal, error))
      .catch((writeError: unknown) =>
        console.error('[automations] could not record a failed launch', writeError)
      )
  }

  /** Only an unlaunched run of this generation fails; a flush error after launch is not a launch failure. */
  private async recordFailedLaunch(run: AutomationRun, signal: AbortSignal, error: unknown) {
    const current = this.store.listAutomationRuns(run.automationId).find((r) => r.id === run.id)
    const unlaunched = current?.status === 'pending' || current?.status === 'dispatching'
    const active = !this.stopped && !signal.aborted
    if (unlaunched && active && !(error instanceof AutomationDispatchCancelledError)) {
      const message = error instanceof Error ? error.message : String(error)
      await this.markDispatchResult({ runId: run.id, status: 'dispatch_failed', error: message })
    }
  }

  /** One run per source event; null when the automation no longer takes it (removed, paused, trigger gone). */
  runForEvent(automationId: string, event: AutomationRunEvent, gate?: EventRunOptions) {
    return runForEvent(this.triggerRunContext(), automationId, event, gate)
  }

  async recordRefusedRun(automationId: string): Promise<void> {
    const automation = this.store.listAutomations().find((entry) => entry.id === automationId)
    if (automation) {
      await recordRefusedAutomationRun({
        store: this.store,
        runs: this.runs,
        automation,
        allowRemoteHostScheduling: this.allowRemoteHostScheduling
      })
    }
  }

  async runPrecheck(automationId: string, runId: string): Promise<AutomationPrecheckResult | null> {
    return runAutomationRequestPrecheck(this.store, automationId, runId, (automation) =>
      this.resolveTarget(automation)
    )
  }

  async markDispatchResult(result: AutomationDispatchResult): Promise<AutomationRun> {
    const run = await this.runs.updateRun(result)
    clearAutomationDispatchTokens(run.automationId, run.id)
    if (!isFinalAutomationRunStatus(run.status)) {
      if (run.status === 'dispatched') {
        this.completionWatcher?.watch(run)
      }
      return run
    }
    this.completionWatcher?.forget(run.id)
    // Duplicate completion effects must not recalculate usage with a later attribution window.
    if (run.usage) {
      return run
    }
    return await writeAutomationRunUsage({
      store: this.store,
      runs: this.runs,
      run,
      claudeUsage: this.claudeUsage,
      codexUsage: this.codexUsage
    })
  }

  private async evaluateDueRuns(): Promise<void> {
    // A run started in a dark wake is cut off by the next sleep.
    if (this.evaluating || this.stopped || !this.wakeGate.admits(this.store)) {
      return
    }
    this.evaluating = true
    const signal = this.dispatchAbort.signal
    if (this.availableLauncher()) {
      this.completionWatcher?.markTerminalSurfaceReady()
    }
    const now = Date.now()
    try {
      await runDueAutomations({
        ctx: this.triggerRunContext(this.wakeGate.takeDelayMs(now, this.tickMs)),
        now,
        isActive: () => !this.stopped && !signal.aborted,
        captureTarget: (listed) =>
          captureLegacyRunTarget(this.store, listed, this.allowRemoteHostScheduling)
      })
    } finally {
      this.evaluating = false
    }
  }

  /** Captures the dispatch signal, so a stop() while it waits cancels the launch. */
  private triggerRunContext(wakeGateDelayMs = 0): AutomationTriggerRunContext {
    const signal = this.dispatchAbort.signal
    return {
      store: this.store,
      runs: this.runs,
      wakeGateDelayMs,
      inLane: (automationId, operation) => this.runInAutomationLane(automationId, operation),
      describeRefusal: (target) => {
        const canDispatch = canDispatchTo(
          { repo: Boolean(this.availableLauncher()), bot: Boolean(this.botDispatcher) },
          target
        )
        return describeScheduledTickRefusal(this.store, { target, canDispatch })
      },
      resolveTarget: (automation) => this.resolveTarget(automation),
      dispatch: (automation, run, target) => this.requestDispatch(automation, run, target, signal),
      launch: (automation, run, target, afterCreate) =>
        this.launchInLane(automation, run, target, signal, afterCreate),
      once: this.once
    }
  }

  private resolveTarget(automation: Automation): AutomationRunTargetResult {
    return resolveAutomationRunTarget(this.store, automation, {
      allowRemoteHostScheduling: this.allowRemoteHostScheduling
    })
  }

  /** The terminal launcher, while a window graph can hold run terminals. */
  private availableLauncher(): Launch.AutomationLauncher | null {
    return this.terminalLauncher?.available() ? this.terminalLauncher.launch : null
  }

  /** Serialize dispatch and retention per automation until launch, without holding the lane during agent work. */
  runInAutomationLane<T>(automationId: string, operation: () => Promise<T>): Promise<T> {
    return runKeyedSerializedOperation(this.automationLanes, automationId, operation)
  }

  private requestDispatch(
    automation: Automation,
    run: AutomationRun,
    target: AutomationRunTargetResult,
    signal: AbortSignal
  ): Promise<AutomationRun> {
    return this.runInAutomationLane(automation.id, () =>
      requestAutomationDispatch(
        {
          store: this.store,
          runs: this.runs,
          isActive: () => !this.stopped && !signal.aborted,
          launcher: () => this.availableLauncher(),
          botDispatcher: this.botDispatcher,
          prepareCodexRun: this.prepareCodexRun,
          signal,
          chatDispatcher:
            this.allowRemoteHostScheduling || this.availableLauncher() ? this.chatDispatcher : null,
          resolveTarget: (current) => this.resolveTarget(current),
          ...(this.onRunRefused ? { onRunRefused: this.onRunRefused } : {}),
          runPrecheck: () => this.runPrecheck(automation.id, run.id),
          markDispatchResult: (result) => this.markDispatchResult(result),
          watchRun: (dispatched) => this.completionWatcher?.watch(dispatched)
        },
        automation,
        run,
        target
      )
    )
  }
}
