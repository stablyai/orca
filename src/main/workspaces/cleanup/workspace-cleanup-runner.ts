import { randomUUID } from 'node:crypto'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import { readWorkspaceSpaceAnalysisSnapshot } from '../space-analysis/workspace-space-analysis-snapshot'
import {
  getDefaultWorkspaceCleanupRules,
  type WorkspaceCleanupRules
} from '../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type {
  WorkspaceCleanupEvaluation,
  WorkspaceCleanupRuleReason
} from '../../../shared/workspace-cleanup/workspace-cleanup-evaluation'
import { errorMessage } from '../../../shared/errors/error-message'
import type {
  WorkspaceCleanupPreview,
  WorkspaceCleanupReport,
  WorkspaceCleanupRun,
  WorkspaceCleanupRunRow,
  WorkspaceCleanupRowDetails,
  WorkspaceCleanupRunTrigger,
  WorkspaceCleanupWorkspaceRef
} from '../../../shared/workspace-cleanup/workspace-cleanup-run'
import {
  collectWorkspaceCleanupWorkspaces,
  type WorkspaceCleanupWorkspace
} from './workspace-cleanup-run-evidence'
import { decideWorkspaceCleanup, removeWorkspaceForCleanup } from './workspace-cleanup-removal-step'
import {
  keptRunOutcome,
  summarizeWorkspaceCleanupRun,
  workspaceCleanupRowDetails
} from './workspace-cleanup-run-summary'
import {
  appendWorkspaceCleanupRun,
  readWorkspaceCleanupRunHistory
} from './workspace-cleanup-run-history'
import { listEnabledWorkspaceCleanupRules } from './workspace-cleanup-enabled-rules'
import { ChatHistorySweepSchedule } from './chat-history/chat-history-sweep-schedule'

// Let the window restore its terminals and session drafts before the first evidence read.
const STARTUP_DELAY_MS = 2 * 60 * 1000
const HOURLY_MS = 60 * 60 * 1000
// One settings write per toggle; coalesce a burst of them into one run.
const SETTINGS_DEBOUNCE_MS = 10 * 1000

type DecidedWorkspace = {
  workspace: WorkspaceCleanupWorkspace
  ref: WorkspaceCleanupWorkspaceRef & WorkspaceCleanupRowDetails & { sizeBytes?: number }
  evaluation: WorkspaceCleanupEvaluation
}

export type WorkspaceCleanupRunnerDeps = {
  runtime: OrcaRuntimeService
  store: RuntimeStore
  /** Profile storage directory: the run history and space-analysis sidecars live here. */
  historyDirectory: string
}

/** Applies the user's cleanup rules to the workspaces this process owns, one run at a time. */
export class WorkspaceCleanupRunner {
  private readonly deps: WorkspaceCleanupRunnerDeps
  private current: Promise<WorkspaceCleanupRun> | null = null
  // Every caller asking for the same rules while one evaluation runs shares it: reopened pages, several clients.
  private readonly previews = new Map<string, Promise<WorkspaceCleanupPreview>>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private nextRunAt: number | null = null
  private nextTrigger: WorkspaceCleanupRunTrigger | null = null
  private enabledRules = new Set<string>()
  private chatHistoryOn = false
  private unsubscribe: (() => void) | null = null
  private readonly abort = new AbortController()

  private readonly chatHistory: ChatHistorySweepSchedule

  constructor(deps: WorkspaceCleanupRunnerDeps) {
    this.deps = deps
    this.chatHistory = new ChatHistorySweepSchedule(deps.store)
  }

  start(): void {
    if (this.unsubscribe) {
      return
    }
    this.enabledRules = listEnabledWorkspaceCleanupRules(this.deps.store)
    this.chatHistoryOn = this.chatHistory.isOn()
    this.unsubscribe = this.deps.runtime.onClientEvent(
      (event) => {
        if (
          event.type === 'reposChanged' ||
          (event.type === 'settingsChanged' &&
            (event.keys.includes('workspaceCleanupPolicy') ||
              event.keys.includes('deleteChatHistoryWithWorkspace')))
        ) {
          this.noteRulesChanged()
        }
      },
      // Counting as a consumer would turn on per-chunk terminal output scanning on headless hosts.
      { consumesTerminalSideEffects: false }
    )
    this.schedule(STARTUP_DELAY_MS, 'startup')
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
    this.nextRunAt = null
    this.abort.abort()
  }

  isRunning(): boolean {
    return this.current !== null
  }

  /** Runs now, or joins the run already going: runs never overlap. */
  runNow(
    trigger: Extract<WorkspaceCleanupRunTrigger, 'run-now' | 'cli'>
  ): Promise<WorkspaceCleanupRun> {
    return this.current ?? this.track(this.execute(trigger))
  }

  /** What a run would do now, removing nothing; `rules` previews other global rules. */
  preview(rules?: WorkspaceCleanupRules): Promise<WorkspaceCleanupPreview> {
    const effective = rules ?? this.globalRules()
    const key = JSON.stringify(effective)
    const shared = this.previews.get(key)
    if (shared) {
      return shared
    }
    const evaluation = this.evaluatePreview(effective)
    this.previews.set(key, evaluation)
    void evaluation
      .catch(() => undefined)
      .finally(() => {
        if (this.previews.get(key) === evaluation) {
          this.previews.delete(key)
        }
      })
    return evaluation
  }

  private async evaluatePreview(rules: WorkspaceCleanupRules): Promise<WorkspaceCleanupPreview> {
    const evaluatedAt = Date.now()
    const decided = await this.evaluate(rules, evaluatedAt)
    return { evaluatedAt, rows: decided.map(({ ref, evaluation }) => ({ ...ref, evaluation })) }
  }

  async report(): Promise<WorkspaceCleanupReport> {
    return {
      runs: await readWorkspaceCleanupRunHistory(this.deps.historyDirectory),
      running: this.isRunning(),
      nextRunAt: this.reportedNextRunAt()
    }
  }

  private hasWork(): boolean {
    return this.enabledRules.size > 0 || this.chatHistoryOn
  }

  /** With only chat history on, hourly ticks before its sweep is due run nothing, so report the one that does. */
  private reportedNextRunAt(): number | null {
    const next = this.nextRunAt
    if (next === null || !this.hasWork()) {
      return null
    }
    const due = this.chatHistory.hourlyDueAt()
    return this.enabledRules.size > 0 || this.nextTrigger !== 'hourly' || due <= next
      ? next
      : next + Math.ceil((due - next) / HOURLY_MS) * HOURLY_MS
  }

  private globalRules(): WorkspaceCleanupRules {
    return this.deps.store.getSettings().workspaceCleanupPolicy ?? getDefaultWorkspaceCleanupRules()
  }

  private schedule(delayMs: number, trigger: WorkspaceCleanupRunTrigger): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.nextRunAt = Date.now() + delayMs
    this.nextTrigger = trigger
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runScheduled(trigger)
    }, delayMs)
    this.timer.unref?.()
  }

  private async runScheduled(trigger: WorkspaceCleanupRunTrigger): Promise<void> {
    try {
      // A run already going may have read the rules before the change that scheduled this one.
      await this.current?.catch(() => undefined)
      // Off by default: with nothing due, a scheduled run costs nothing and leaves no record.
      if (
        this.unsubscribe &&
        (this.enabledRules.size > 0 || this.chatHistory.isDue(trigger, Date.now()))
      ) {
        await (this.current ?? this.track(this.execute(trigger)))
      }
    } catch (error) {
      console.error('[workspace-cleanup] Scheduled run failed', error)
    } finally {
      // A rule change during this run already queued its own run; don't push it out an hour.
      if (this.unsubscribe && !this.timer) {
        this.schedule(HOURLY_MS, 'hourly')
      }
    }
  }

  private noteRulesChanged(): void {
    const previous = this.enabledRules
    const chatHistoryWasOn = this.chatHistoryOn
    this.enabledRules = listEnabledWorkspaceCleanupRules(this.deps.store)
    this.chatHistoryOn = this.chatHistory.isOn()
    if (
      [...this.enabledRules].some((rule) => !previous.has(rule)) ||
      (this.chatHistoryOn && !chatHistoryWasOn)
    ) {
      this.schedule(SETTINGS_DEBOUNCE_MS, 'settings')
    }
  }

  private track(run: Promise<WorkspaceCleanupRun>): Promise<WorkspaceCleanupRun> {
    this.current = run
    void run.finally(() => {
      if (this.current === run) {
        this.current = null
      }
    })
    return run
  }

  /** Every owned workspace with its verdict now; preview and runs share it so they never disagree. */
  private async evaluate(
    globalRules: WorkspaceCleanupRules,
    now: number
  ): Promise<DecidedWorkspace[]> {
    const [workspaces, sizes] = await Promise.all([
      collectWorkspaceCleanupWorkspaces({
        store: this.deps.store,
        runtime: this.deps.runtime,
        globalRules,
        now,
        signal: this.abort.signal
      }),
      this.readSizes()
    ])
    const decided: DecidedWorkspace[] = []
    for (const workspace of workspaces) {
      const sizeBytes = sizes.get(workspace.ref.worktreeId)
      decided.push({
        workspace,
        ref: {
          ...workspace.ref,
          ...workspaceCleanupRowDetails(workspace.input),
          ...(sizeBytes !== undefined ? { sizeBytes } : {})
        },
        evaluation: await decideWorkspaceCleanup(this.deps.runtime, workspace, now)
      })
    }
    return decided
  }

  private async readSizes(): Promise<Map<string, number>> {
    const analysis = await readWorkspaceSpaceAnalysisSnapshot(this.deps.historyDirectory)
    const sizes = new Map<string, number>()
    for (const row of analysis?.worktrees ?? []) {
      if (row.status === 'ok') {
        sizes.set(row.worktreeId, row.sizeBytes)
      }
    }
    return sizes
  }

  private async execute(trigger: WorkspaceCleanupRunTrigger): Promise<WorkspaceCleanupRun> {
    const startedAt = Date.now()
    const rows: WorkspaceCleanupRunRow[] = []
    let error: string | undefined
    try {
      const removals: (DecidedWorkspace & { reason: WorkspaceCleanupRuleReason })[] = []
      // With no rule on every workspace is kept unwatched, so skip the Git reads behind that verdict.
      const decided =
        this.enabledRules.size > 0 ? await this.evaluate(this.globalRules(), startedAt) : []
      for (const { workspace, ref, evaluation } of decided) {
        if (evaluation.action === 'delete') {
          removals.push({ workspace, ref, evaluation, reason: evaluation.reason })
        } else {
          rows.push({ ...ref, ...keptRunOutcome(evaluation) })
        }
      }
      // Nested checkouts first, so a parent's removal never sweeps a child it did not re-check.
      removals.sort((a, b) => b.ref.path.length - a.ref.path.length)
      for (const { workspace, ref, reason } of removals) {
        if (this.abort.signal.aborted) {
          break
        }
        const outcome = await removeWorkspaceForCleanup({
          runtime: this.deps.runtime,
          store: this.deps.store,
          globalRules: () => this.globalRules(),
          workspace,
          now: () => Date.now(),
          signal: this.abort.signal
        })
        rows.push({ ...ref, reason, ...outcome })
      }
    } catch (cause) {
      error = errorMessage(cause)
    }
    // After removals, so this run's deleted workspaces are gone from disk; a rule failure doesn't block it.
    const chatHistory = await this.chatHistory.sweepIfDue(trigger, startedAt, this.abort.signal)
    const run = summarizeWorkspaceCleanupRun({
      id: randomUUID(),
      trigger,
      startedAt,
      finishedAt: Date.now(),
      rows,
      ...(chatHistory ? { chatHistory } : {}),
      ...(error ? { error } : {})
    })
    await this.record(run)
    return run
  }

  private async record(run: WorkspaceCleanupRun): Promise<void> {
    try {
      await appendWorkspaceCleanupRun(this.deps.historyDirectory, run)
    } catch (error) {
      console.error('[workspace-cleanup] Could not save the run report', error)
    }
    const { rows: _rows, ...summary } = run
    this.deps.runtime.notifyWorkspaceCleanupRunFinished(summary)
  }
}
