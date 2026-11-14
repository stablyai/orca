import type { AgentSessionExecutionUsage } from '../../../../shared/agent-session/agent-session-execution-evidence'
import { readCodexCumulativeUsage } from './codex-context-usage'
import { codexThreadStoppedRunning } from '../../app-server/codex-structured-thread-facts'

export class CodexCumulativeUsageMeter {
  epoch = 0
  activityRevision = 0
  quiescent = false
  usage?: AgentSessionExecutionUsage
  origin: 'fresh-thread' | 'provider-counter' = 'provider-counter'
  private previous?: AgentSessionExecutionUsage
  private corrupt = false
  private settingsKey = ''

  open(threadId: string, fresh: boolean, settings: Record<string, unknown>, now: number): void {
    this.settingsKey = this.key(settings)
    this.quiescent = fresh || codexThreadStoppedRunning(settings.thread)
    if (fresh && !this.previous && !this.corrupt) {
      this.origin = 'fresh-thread'
      this.usage = {
        threadId,
        observedAt: now,
        totalTokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0
      }
    }
  }

  settings(value: Record<string, unknown>): void {
    const key = this.key(value)
    if (key !== this.settingsKey) {
      this.settingsKey = key
      this.invalidate()
    }
  }

  invalidate(): void {
    this.epoch += 1
    if (this.origin !== 'fresh-thread') {
      this.usage = undefined
    }
  }

  invalidateUsage(): void {
    this.invalidate()
    this.usage = undefined
    this.corrupt = true
  }

  activity(quiescent: boolean): void {
    this.activityRevision += 1
    this.quiescent = quiescent
    if (!quiescent) {
      this.origin = 'provider-counter'
      this.usage = undefined
    }
  }

  observe(params: unknown, threadId: string, now: number): void {
    if (this.corrupt) {
      return
    }
    const usage = readCodexCumulativeUsage(params, threadId, now, this.previous)
    this.origin = 'provider-counter'
    this.usage = usage
    if (usage) {
      this.previous = usage
    } else {
      this.corrupt = true
    }
  }

  private key(value: Record<string, unknown>): string {
    return JSON.stringify([value.model, value.effort, value.modelProvider])
  }
}
