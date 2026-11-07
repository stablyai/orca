import {
  AutomationDispatchCancelledError,
  requestAutomationDispatch,
  runAutomationRequestPrecheck
} from './automation-dispatch-request'
import type { Store } from '../persistence/loading-store/store'
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
import type { AutomationLauncher, AutomationTerminalLauncher } from './automation-launch'
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
import type { RunTerminalRetention } from './run-terminal-retention'
import type {
  AutomationsChangedPayload,
  PublishAutomationsChanged
} from '../../shared/runtime-client-events'

const DEFAULT_TICK_MS = 60 * 1000

export class AutomationService {
  private readonly store: Store
  private readonly tickMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private evaluating = false
  private stopped = false
  private dispatchGeneration = 0
  private readonly claudeUsage: ClaudeUsageStore | null
  private readonly codexUsage: CodexUsageStore | null
  private readonly allowRemoteHostScheduling: boolean
  private readonly terminalLauncher: AutomationTerminalLauncher | null
  private readonly chatDispatcher: AutomationLauncher | null
  private readonly automationLanes = new Map<string, Promise<void>>()
  /** Shares this service's lanes and tick; `drain` closes unused completed run terminals. */
  readonly runTerminalRetention: RunTerminalRetention | null
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
      terminalLauncher?: AutomationTerminalLauncher
      chatDispatcher?: AutomationLauncher
      terminalObserver?: AutomationRunTerminalObserver
      onAutomationsChanged?: PublishAutomationsChanged
      runTerminalRetention?: (service: AutomationService) => RunTerminalRetention
    } = {}
  ) {
    this.store = store
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS
    this.claudeUsage = opts.claudeUsage ?? null
    this.codexUsage = opts.codexUsage ?? null
    this.allowRemoteHostScheduling = opts.allowRemoteHostScheduling ?? false
    this.terminalLauncher = opts.terminalLauncher ?? null
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
    // The saved pending row is the acknowledgement; the lane owns execution behind earlier launches.
    this.launchInLane(automation, run, target, generation)
    return run
  }

  /** Detached so due runs start together; every failure after createRun settles the row. */
  private launchInLane(
    automation: Automation,
    run: AutomationRun,
    target: AutomationRunTargetResult,
    generation: number,
    afterCreate?: () => Promise<unknown>
  ): void {
    void (async () => {
      // A blocked lane must not defer the schedule advance.
      await afterCreate?.()
      await this.requestDispatch(automation, run, target, generation)
    })()
      .catch((error: unknown) => this.recordFailedLaunch(run, generation, error))
      .catch((writeError: unknown) =>
        console.error('[automations] could not record a failed launch', writeError)
      )
  }

  /** Only an unlaunched run of this generation fails; a flush error after launch is not a launch failure. */
  private async recordFailedLaunch(run: AutomationRun, generation: number, error: unknown) {
    const current = this.store.listAutomationRuns(run.automationId).find((r) => r.id === run.id)
    const unlaunched = current?.status === 'pending' || current?.status === 'dispatching'
    const active = !this.stopped && generation === this.dispatchGeneration
    if (unlaunched && active && !(error instanceof AutomationDispatchCancelledError)) {
      const message = error instanceof Error ? error.message : String(error)
      await this.markDispatchResult({ runId: run.id, status: 'dispatch_failed', error: message })
    }
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
    if (this.availableLauncher()) {
      this.completionWatcher?.markTerminalSurfaceReady()
    }
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
    const canDispatch = Boolean(this.availableLauncher())
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

    const run = await this.runs.createRun(automation, scheduledFor)
    this.launchInLane(automation, run, target, generation, () =>
      this.runs.advanceNextRun(automation.id, now)
    )
  }

  private resolveTarget(automation: Automation): AutomationRunTargetResult {
    return resolveAutomationRunTarget(this.store, automation, {
      allowRemoteHostScheduling: this.allowRemoteHostScheduling
    })
  }

  /** The terminal launcher, while a window graph can hold run terminals. */
  private availableLauncher(): AutomationLauncher | null {
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
    generation: number
  ): Promise<AutomationRun> {
    return this.runInAutomationLane(automation.id, () =>
      requestAutomationDispatch(
        {
          store: this.store,
          runs: this.runs,
          isActive: () => !this.stopped && generation === this.dispatchGeneration,
          launcher: () => this.availableLauncher(),
          chatDispatcher:
            this.allowRemoteHostScheduling || this.availableLauncher() ? this.chatDispatcher : null,
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
