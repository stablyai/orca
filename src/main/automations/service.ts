import type { WebContents } from 'electron'
import type { Store } from '../persistence'
import type {
  Automation,
  AutomationDispatchRequest,
  AutomationDispatchResult,
  AutomationRun,
  AutomationRunStatus,
  AutomationRunUsage
} from '../../shared/automations-types'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'

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

  constructor(
    store: Store,
    opts: { tickMs?: number; claudeUsage?: ClaudeUsageStore; codexUsage?: CodexUsageStore } = {}
  ) {
    this.store = store
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS
    this.claudeUsage = opts.claudeUsage ?? null
    this.codexUsage = opts.codexUsage ?? null
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
    if (this.rendererReady) {
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
    await this.requestDispatch(automation, run)
    return run
  }

  async markDispatchResult(result: AutomationDispatchResult): Promise<AutomationRun> {
    const run = this.store.updateAutomationRun(result)
    if (!isFinalRunStatus(run.status)) {
      return run
    }
    const usage = await this.collectRunUsage(run)
    return this.store.updateAutomationRun({
      runId: run.id,
      status: run.status,
      workspaceId: run.workspaceId,
      terminalSessionId: run.terminalSessionId,
      usage,
      error: run.error
    })
  }

  private async collectRunUsage(run: AutomationRun): Promise<AutomationRunUsage> {
    const automation = this.store.listAutomations().find((entry) => entry.id === run.automationId)
    const collectedAt = Date.now()
    const unavailable = (
      provider: AutomationRunUsage['provider'],
      unavailableReason: AutomationRunUsage['unavailableReason'],
      unavailableMessage: string
    ): AutomationRunUsage => ({
      status: 'unavailable',
      provider,
      model: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
      estimatedCostUsd: null,
      estimatedCostSource: null,
      providerSessionId: null,
      attribution: null,
      collectedAt,
      unavailableReason,
      unavailableMessage
    })

    if (!automation || run.status !== 'completed') {
      return unavailable(
        automation?.agentId === 'codex'
          ? 'codex'
          : automation?.agentId === 'claude'
            ? 'claude'
            : null,
        'run_not_finished',
        'Usage is only collected for completed automation runs.'
      )
    }
    if (automation.executionTargetType === 'ssh') {
      return unavailable(
        automation.agentId === 'codex'
          ? 'codex'
          : automation.agentId === 'claude'
            ? 'claude'
            : null,
        'remote_usage_unavailable',
        'Remote automation usage is not available from local usage logs.'
      )
    }
    if (automation.agentId === 'claude') {
      if (!this.claudeUsage) {
        return unavailable('claude', 'scan_failed', 'Claude usage store is unavailable.')
      }
      return this.claudeUsage.getAutomationRunUsage({
        worktreeId: run.workspaceId,
        terminalSessionId: run.terminalSessionId,
        startedAt: run.startedAt,
        completedAt: collectedAt
      })
    }
    if (automation.agentId === 'codex') {
      if (!this.codexUsage) {
        return unavailable('codex', 'scan_failed', 'Codex usage store is unavailable.')
      }
      return this.codexUsage.getAutomationRunUsage({
        worktreeId: run.workspaceId,
        terminalSessionId: run.terminalSessionId,
        startedAt: run.startedAt,
        completedAt: collectedAt
      })
    }
    return unavailable(
      null,
      'provider_unsupported',
      'This agent does not report usage to Orca yet.'
    )
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

  private async requestDispatch(automation: Automation, run: AutomationRun): Promise<void> {
    const webContents = this.webContents
    if (!webContents || webContents.isDestroyed() || !this.rendererReady) {
      this.store.updateAutomationRun({
        runId: run.id,
        status: 'skipped_unavailable',
        workspaceId: automation.workspaceId,
        error: 'No Orca window was available to launch the automation.'
      })
      return
    }
    this.store.updateAutomationRun({
      runId: run.id,
      status: 'dispatching',
      workspaceId: automation.workspaceId,
      error: null
    })
    const payload: AutomationDispatchRequest = { automation, run }
    webContents.send('automations:dispatchRequested', payload)
  }
}

function isFinalRunStatus(status: AutomationRunStatus): boolean {
  return (
    status === 'completed' ||
    status === 'dispatch_failed' ||
    status === 'skipped_missed' ||
    status === 'skipped_unavailable' ||
    status === 'skipped_needs_interactive_auth'
  )
}
