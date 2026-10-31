import {
  AutomationDispatchCancelledError,
  requestAutomationDispatch,
  runAutomationRequestPrecheck,
  type AutomationRendererChannel
} from './automation-dispatch-request'
export type { AutomationRendererChannel } from './automation-dispatch-request'
import type { Store } from '../persistence'
import {
  isFinalAutomationRunStatus,
  type Automation,
  type AutomationDispatchResult,
  type AutomationPrecheckResult,
  type AutomationRun
} from '../../shared/automations-types'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import {
  captureLegacyRunTarget,
  resolveAutomationRunTarget,
  type AutomationRunTargetResult
} from './run-target-resolution'
import { writeAutomationRunUsage } from './run-usage-collection'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'
import { clearAutomationDispatchTokens } from './dispatch-tokens'
import {
  AutomationRunCompletionWatcher,
  type AutomationRunTerminalObserver
} from './run-completion-watcher'
import { createAutomationRunWriter, type AutomationRunWriter } from './automation-run-writer'
import { reportAutomationScheduleDrift } from './schedule-drift-report'
import {
  describeScheduledTickRefusal,
  missedBeyondGrace,
  recordMissedRun,
  recordRefusedAutomationRun,
  recordUnevaluableAutomation
} from './dispatch-refusal'
import type {
  AutomationsChangedPayload,
  PublishAutomationsChanged
} from '../../shared/runtime-client-events'

const DEFAULT_TICK_MS = 60 * 1000

export class AutomationService {
  private readonly store: Store
  private readonly tickMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private webContents: AutomationRendererChannel | null = null
  private rendererReady = false
  private evaluating = false
  private stopped = false
  private dispatchGeneration = 0
  private readonly claudeUsage: ClaudeUsageStore | null
  private readonly codexUsage: CodexUsageStore | null
  private readonly allowRemoteHostScheduling: boolean
  private readonly headlessDispatcher: HeadlessAutomationDispatcher | null
  private readonly chatDispatcher: HeadlessAutomationDispatcher | null
  private readonly automationLanes = new Map<string, Promise<void>>()
  /** Close unused completed terminals on headless hosts; return the count. */
  releaseFinishedRunTerminals: (() => Promise<number>) | null = null
  private readonly publish: PublishAutomationsChanged | null
  private readonly runs: AutomationRunWriter
  private readonly completionWatcher: AutomationRunCompletionWatcher | null
  /** Desktop automation traffic holds this lease to defer queued external probes. */
  externalProbePriority: (<T>(run: () => T) => T) | null = null

  constructor(
    store: Store,
    opts: {
      tickMs?: number
      claudeUsage?: ClaudeUsageStore
      codexUsage?: CodexUsageStore
      allowRemoteHostScheduling?: boolean
      headlessDispatcher?: HeadlessAutomationDispatcher
      chatDispatcher?: HeadlessAutomationDispatcher
      terminalObserver?: AutomationRunTerminalObserver
      onAutomationsChanged?: PublishAutomationsChanged
    } = {}
  ) {
    this.store = store
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS
    this.claudeUsage = opts.claudeUsage ?? null
    this.codexUsage = opts.codexUsage ?? null
    this.allowRemoteHostScheduling = opts.allowRemoteHostScheduling ?? false
    this.headlessDispatcher = opts.headlessDispatcher ?? null
    this.chatDispatcher = opts.chatDispatcher ?? null
    this.publish = opts.onAutomationsChanged ?? null
    this.runs = createAutomationRunWriter(store, this.publish)
    this.completionWatcher = opts.terminalObserver
      ? new AutomationRunCompletionWatcher({
          observer: opts.terminalObserver,
          readRun: (automationId, runId) =>
            this.store.listAutomationRuns(automationId).find((entry) => entry.id === runId) ?? null,
          markDispatchResult: (result) => this.markDispatchResult(result)
        })
      : null
  }

  publishAutomationsChanged(payload: AutomationsChangedPayload = {}): void {
    this.publish?.(payload)
  }

  setWebContents(webContents: AutomationRendererChannel | null): void {
    this.webContents = webContents
    this.rendererReady = false
  }

  setRendererReady(): void {
    this.rendererReady = true
    // Pane lookup becomes authoritative after the renderer publishes its window graph.
    this.completionWatcher?.markTerminalSurfaceReady()
    void this.evaluateDueRuns()
  }

  start(): void {
    if (this.timer) {
      return
    }
    this.stopped = false
    this.timer = setInterval(() => {
      void this.evaluateDueRuns()
    }, this.tickMs)
    this.completionWatcher?.reconcileRetainedRuns(this.store.listAutomationRuns())
    reportAutomationScheduleDrift(this.store.listAutomations())
    // Headless hosts need startup catch-up without a renderer-ready notification.
    if (this.rendererReady || this.headlessDispatcher) {
      // Serve adopts PTYs and publishes its graph before start().
      this.completionWatcher?.markTerminalSurfaceReady()
      void this.evaluateDueRuns()
    }
  }

  stop(): void {
    this.stopped = true
    this.dispatchGeneration += 1
    this.completionWatcher?.dispose()
    if (!this.timer) {
      return
    }
    clearInterval(this.timer)
    this.timer = null
  }

  async runNow(automationId: string): Promise<AutomationRun> {
    const generation = this.dispatchGeneration
    const listed = this.store.listAutomations().find((entry) => entry.id === automationId)
    if (!listed) {
      throw new Error('Automation not found.')
    }
    const automation = captureLegacyRunTarget(this.store, listed, this.allowRemoteHostScheduling)
    const target = this.resolveTarget(automation)
    const run = await this.runs.createRun(automation, Date.now(), 'manual')
    return await this.requestDispatch(automation, run, target, generation)
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
    if (this.evaluating || this.stopped) {
      return
    }
    this.evaluating = true
    const generation = this.dispatchGeneration
    try {
      const now = Date.now()
      for (const automation of this.store.listAutomations()) {
        if (this.stopped || generation !== this.dispatchGeneration) {
          break
        }
        if (!automation.enabled || automation.nextRunAt > now) {
          continue
        }
        // A malformed schedule must not prevent later due rows from running.
        try {
          await this.evaluateAutomation(automation, now)
        } catch (error) {
          if (
            !(error instanceof AutomationDispatchCancelledError) &&
            !this.stopped &&
            generation === this.dispatchGeneration &&
            this.store.listAutomations().some((current) => current.id === automation.id)
          ) {
            await recordUnevaluableAutomation({ runs: this.runs, automation, error })
          }
        }
      }
    } finally {
      this.evaluating = false
    }
  }

  private async evaluateAutomation(listed: Automation, now: number): Promise<void> {
    const generation = this.dispatchGeneration
    const automation = captureLegacyRunTarget(this.store, listed, this.allowRemoteHostScheduling)
    const scheduledFor = this.store.getLatestAutomationOccurrence(automation, now)
    if (scheduledFor === null) {
      await this.runs.advanceNextRun(automation.id, now)
      return
    }
    if (missedBeyondGrace({ automation, scheduledFor, now, tickMs: this.tickMs })) {
      await recordMissedRun({ runs: this.runs, automation, scheduledFor })
      await this.runs.advanceNextRun(automation.id, now)
      return
    }

    // Fold recurring refusals before creating rows so they do not evict real run history.
    const target = this.resolveTarget(automation)
    const canDispatch = this.canDispatchToRenderer() || Boolean(this.headlessDispatcher)
    const refusal = await describeScheduledTickRefusal(this.store, { target, canDispatch })
    // Once WSL owns the schedule, avoid churning skips on the retained local copy.
    if (refusal?.errorCode === 'wslMoveOwnedByHost') {
      await this.runs.advanceNextRun(automation.id, now)
      return
    }
    if (refusal && (await this.runs.repeatSkip(automation.id, refusal.error, scheduledFor))) {
      await this.runs.advanceNextRun(automation.id, now)
      return
    }

    await this.requestDispatch(
      automation,
      await this.runs.createRun(automation, scheduledFor),
      target,
      generation
    )
    await this.runs.advanceNextRun(automation.id, now)
  }

  private resolveTarget(automation: Automation): AutomationRunTargetResult {
    return resolveAutomationRunTarget(this.store, automation, {
      allowRemoteHostScheduling: this.allowRemoteHostScheduling
    })
  }

  private canDispatchToRenderer(): boolean {
    const webContents = this.webContents
    return Boolean(webContents && !webContents.isDestroyed() && this.rendererReady)
  }

  /** Serialize dispatch and retention per automation until launch, without holding the lane during agent work. */
  runInAutomationLane<T>(automationId: string, operation: () => Promise<T>): Promise<T> {
    return runKeyedSerializedOperation(this.automationLanes, automationId, operation)
  }

  private requestDispatch(
    automation: Automation,
    run: AutomationRun,
    target: AutomationRunTargetResult,
    generation: number
  ): Promise<AutomationRun> {
    return this.runInAutomationLane(automation.id, () =>
      requestAutomationDispatch(
        {
          store: this.store,
          runs: this.runs,
          isActive: () => !this.stopped && generation === this.dispatchGeneration,
          getRenderer: () => (this.canDispatchToRenderer() ? this.webContents : null),
          headlessDispatcher: this.headlessDispatcher,
          chatDispatcher:
            this.allowRemoteHostScheduling || this.canDispatchToRenderer()
              ? this.chatDispatcher
              : null,
          resolveTarget: (current) => this.resolveTarget(current),
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
