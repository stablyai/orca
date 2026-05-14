import type { WebContents } from 'electron'
import type { Store } from '../persistence'
import type {
  Automation,
  AutomationDispatchRequest,
  AutomationDispatchResult,
  AutomationRun
} from '../../shared/automations-types'

const DEFAULT_TICK_MS = 60 * 1000

export class AutomationService {
  private readonly store: Store
  private readonly tickMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private webContents: WebContents | null = null
  private rendererReady = false
  private evaluating = false

  constructor(store: Store, opts: { tickMs?: number } = {}) {
    this.store = store
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS
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

  markDispatchResult(result: AutomationDispatchResult): AutomationRun {
    return this.store.updateAutomationRun(result)
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
