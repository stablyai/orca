import type { WebContents } from 'electron'
import type { Store } from '../persistence'
import {
  isFinalAutomationRunStatus,
  type Automation,
  type AutomationDispatchRequest,
  type AutomationDispatchResult,
  type AutomationPrecheckResult,
  type AutomationRun
} from '../../shared/automations-types'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import { runAutomationPrecheck } from './precheck-runner'
import { resolveAutomationRunTarget, type AutomationRunTargetResult } from './run-target-resolution'
import { collectAutomationRunUsage } from './run-usage-collection'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'
import { clearAutomationDispatchTokens, createAutomationDispatchToken } from './dispatch-tokens'
import {
  didAutomationPrecheckPass,
  formatAutomationPrecheckFailure
} from '../../shared/automation-precheck'

const DEFAULT_TICK_MS = 60 * 1000

export class AutomationService {
  private readonly store: Store
  private readonly tickMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private webContents: WebContents | null = null
  private rendererReady = false
  private evaluating = false
  private readonly claudeUsage: ClaudeUsageStore | null
  private readonly codexUsage: CodexUsageStore | null
  private readonly allowRemoteHostScheduling: boolean
  private readonly headlessDispatcher: HeadlessAutomationDispatcher | null

  constructor(
    store: Store,
    opts: {
      tickMs?: number
      claudeUsage?: ClaudeUsageStore
      codexUsage?: CodexUsageStore
      allowRemoteHostScheduling?: boolean
      headlessDispatcher?: HeadlessAutomationDispatcher
    } = {}
  ) {
    this.store = store
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS
    this.claudeUsage = opts.claudeUsage ?? null
    this.codexUsage = opts.codexUsage ?? null
    this.allowRemoteHostScheduling = opts.allowRemoteHostScheduling ?? false
    this.headlessDispatcher = opts.headlessDispatcher ?? null
  }

  setWebContents(webContents: WebContents | null): void {
    this.webContents = webContents
    this.rendererReady = false
  }

  setRendererReady(): void {
    this.rendererReady = true
    void this.evaluateDueRuns()
  }

  start(): void {
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => {
      void this.evaluateDueRuns()
    }, this.tickMs)
    // Why: headless serve never gets a renderer-ready IPC, but due runs still
    // need the same startup catch-up pass desktop gets after renderer attach.
    if (this.rendererReady || this.headlessDispatcher) {
      void this.evaluateDueRuns()
    }
  }

  stop(): void {
    if (!this.timer) {
      return
    }
    clearInterval(this.timer)
    this.timer = null
  }

  async runNow(automationId: string): Promise<AutomationRun> {
    const automation = this.store.listAutomations().find((entry) => entry.id === automationId)
    if (!automation) {
      throw new Error('Automation not found.')
    }
    const run = this.store.createAutomationRun(automation, Date.now(), 'manual')
    return await this.requestDispatch(automation, run)
  }

  async runPrecheck(automationId: string, runId: string): Promise<AutomationPrecheckResult | null> {
    const automation = this.store.listAutomations().find((entry) => entry.id === automationId)
    if (!automation) {
      throw new Error('Automation not found.')
    }
    const run = this.store.listAutomationRuns(automationId).find((entry) => entry.id === runId)
    if (!run) {
      throw new Error('Automation run not found.')
    }
    if (run.trigger !== 'scheduled' || !automation.precheck) {
      return null
    }
    const target = resolveAutomationRunTarget(this.store, automation, {
      allowRemoteHostScheduling: this.allowRemoteHostScheduling
    })
    if (!target.ok) {
      return {
        command: automation.precheck.command,
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        error: target.error,
        startedAt: Date.now(),
        completedAt: Date.now()
      }
    }
    return await runAutomationPrecheck({
      precheck: automation.precheck,
      target:
        automation.executionTargetType === 'ssh'
          ? { type: 'ssh', cwd: target.cwd, connectionId: automation.executionTargetId }
          : { type: 'local', cwd: target.cwd }
    })
  }

  async markDispatchResult(result: AutomationDispatchResult): Promise<AutomationRun> {
    const run = this.store.updateAutomationRun(result)
    clearAutomationDispatchTokens(run.automationId, run.id)
    if (!isFinalAutomationRunStatus(run.status)) {
      return run
    }
    // Why: the renderer's mark-completed effect can re-fire for the same run
    // before refresh() flips its status snapshot off 'dispatched'. Re-running
    // collectRunUsage advances the attribution window and can rewrite an
    // already-collected 'known' usage to 'unavailable'/'ambiguous_session'.
    if (run.usage) {
      return run
    }
    const usage = await collectAutomationRunUsage({
      automation: this.store.listAutomations().find((entry) => entry.id === run.automationId),
      run,
      claudeUsage: this.claudeUsage,
      codexUsage: this.codexUsage
    })
    // Why: the run is final during the await above, so a concurrent create-time
    // retention prune may have evicted it — the usage write must not throw then.
    if (!this.store.listAutomationRuns(run.automationId).some((entry) => entry.id === run.id)) {
      return run
    }
    return this.store.updateAutomationRun({
      runId: run.id,
      status: run.status,
      workspaceId: run.workspaceId,
      terminalSessionId: run.terminalSessionId,
      usage,
      error: run.error
    })
  }

  private async evaluateDueRuns(): Promise<void> {
    if (this.evaluating) {
      return
    }
    this.evaluating = true
    try {
      const now = Date.now()
      for (const automation of this.store.listAutomations()) {
        if (!automation.enabled || automation.nextRunAt > now) {
          continue
        }
        await this.evaluateAutomation(automation, now)
      }
    } finally {
      this.evaluating = false
    }
  }

  private async evaluateAutomation(automation: Automation, now: number): Promise<void> {
    const scheduledFor = this.store.getLatestAutomationOccurrence(automation, now)
    if (scheduledFor === null) {
      this.store.advanceAutomationNextRun(automation.id, now)
      return
    }
    const run = this.store.createAutomationRun(automation, scheduledFor)
    const graceMs = automation.missedRunGraceMinutes * 60 * 1000
    if (now - scheduledFor > graceMs) {
      this.store.updateAutomationRun({
        runId: run.id,
        status: 'skipped_missed',
        workspaceId: automation.workspaceId,
        error: 'Orca was unavailable during the missed-run grace window.'
      })
      this.store.advanceAutomationNextRun(automation.id, now)
      return
    }

    await this.requestDispatch(automation, run)
    this.store.advanceAutomationNextRun(automation.id, now)
  }

  private async requestDispatch(
    automation: Automation,
    run: AutomationRun
  ): Promise<AutomationRun> {
    const target = resolveAutomationRunTarget(this.store, automation, {
      allowRemoteHostScheduling: this.allowRemoteHostScheduling
    })
    if (!target.ok) {
      return this.store.updateAutomationRun({
        runId: run.id,
        status: 'skipped_unavailable',
        workspaceId: automation.workspaceId,
        error: target.error
      })
    }
    const webContents = this.webContents
    if (!webContents || webContents.isDestroyed() || !this.rendererReady) {
      if (this.headlessDispatcher) {
        return await this.requestHeadlessDispatch(automation, run, target)
      }
      return this.store.updateAutomationRun({
        runId: run.id,
        status: 'skipped_unavailable',
        workspaceId: automation.workspaceId,
        error: 'No Orca window was available to launch the automation.'
      })
    }
    const updated = this.store.updateAutomationRun({
      runId: run.id,
      status: 'dispatching',
      workspaceId: automation.workspaceId,
      error: null
    })
    const payload: AutomationDispatchRequest = {
      automation,
      run: updated,
      dispatchToken: createAutomationDispatchToken(automation.id, updated.id)
    }
    webContents.send('automations:dispatchRequested', payload)
    return updated
  }

  private async requestHeadlessDispatch(
    automation: Automation,
    run: AutomationRun,
    target: Extract<AutomationRunTargetResult, { ok: true }>
  ): Promise<AutomationRun> {
    const precheckResult =
      run.trigger === 'scheduled' && automation.precheck
        ? await this.runPrecheck(automation.id, run.id)
        : null
    if (precheckResult && !didAutomationPrecheckPass(precheckResult)) {
      return this.store.updateAutomationRun({
        runId: run.id,
        status: 'skipped_precheck',
        workspaceId: automation.workspaceId,
        precheckResult,
        error: formatAutomationPrecheckFailure(precheckResult)
      })
    }
    try {
      const launch = await this.headlessDispatcher!({ automation, run, target })
      const launchRunTarget = {
        workspaceId: launch.workspaceId,
        workspaceDisplayName: launch.workspaceDisplayName ?? null,
        terminalSessionId: launch.terminalSessionId,
        terminalPaneKey: launch.terminalPaneKey ?? null,
        terminalPtyId: launch.terminalPtyId ?? null
      }
      const updated = this.store.updateAutomationRun({
        runId: run.id,
        status: 'dispatched',
        ...launchRunTarget,
        error: null
      })
      if (launch.completion) {
        void launch.completion
          .then((completion) =>
            this.markDispatchResult({
              runId: run.id,
              status: completion.status,
              ...launchRunTarget,
              precheckResult,
              outputSnapshot: completion.outputSnapshot ?? null,
              error: completion.error ?? null
            })
          )
          .catch((error) =>
            this.markDispatchResult({
              runId: run.id,
              status: 'dispatch_failed',
              ...launchRunTarget,
              error: error instanceof Error ? error.message : String(error)
            })
          )
      }
      return updated
    } catch (error) {
      return this.store.updateAutomationRun({
        runId: run.id,
        status: 'dispatch_failed',
        workspaceId: automation.workspaceId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
