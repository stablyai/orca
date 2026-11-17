import type { TraexSession } from './traex-session'
import type { StructuredAgentSessionCommandRun } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { ProviderTimelineItemBody } from '../native-chat/agent-session-timeline/provider-timeline-event'
import type {
  StructuredAgentSessionLogFields,
  StructuredAgentSessionLogger
} from '../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { TraexThreadNaming } from './traex-thread-naming'
import { TraexWindowsSandbox } from './traex-windows-sandbox'
import { applyTraexThreadSettings } from './traex-thread-settings'
import { clearTraexModelQueue } from './traex-model-queue'
import { traexRecord, traexText } from './traex-protocol'

/** Protocol events that only change metadata the chat owns beside the transcript. */
export class TraexSessionExtras {
  readonly windowsSandbox: TraexWindowsSandbox
  private naming: TraexThreadNaming | null = null
  private pendingRecap: {
    command: StructuredAgentSessionCommandRun
    providerTurnId: string | null
  } | null = null

  constructor(
    private readonly session: TraexSession,
    private readonly connection: TraexSession['connection'],
    sessionId: string,
    private readonly logger?: StructuredAgentSessionLogger
  ) {
    this.windowsSandbox = new TraexWindowsSandbox(connection, sessionId, logger)
  }

  bindThread(threadId: string): void {
    this.naming = new TraexThreadNaming(this.connection, threadId)
  }

  generateName(): Promise<string | null> {
    return this.naming?.generate() ?? Promise.resolve(null)
  }

  /** Returns true when the event was consumed here rather than by the timeline. */
  observe(method: string, params: Record<string, unknown>): boolean {
    if (method === 'thread/settings/updated' && params.threadId === this.session.threadId) {
      applyTraexThreadSettings(this.session, params.threadSettings)
      return true
    }
    if (method === 'thread/reverted' && params.threadId === this.session.threadId) {
      clearTraexModelQueue(this.session, this.session.queuedModelTurn)
      this.session.activeTurn = null
      this.session.timeline?.flush()
      return true
    }
    if (method === 'thread/name/generated' && params.threadId === this.session.threadId) {
      const name = traexText(params.name)
      if (name) {
        this.naming?.resolve(name)
      }
      return true
    }
    if (method === 'recap/generated' && params.threadId === this.session.threadId) {
      this.finishRecap(params, true)
      return true
    }
    if (method === 'recap/failed' && params.threadId === this.session.threadId) {
      this.finishRecap(params, false)
      return true
    }
    if (method === 'account/rateLimits/updated') {
      this.observeRateLimits(traexRecord(params.rateLimits))
      return true
    }
    return false
  }

  observeSandboxSetup(method: string, value: unknown): boolean {
    if (method !== 'windowsSandbox/setupCompleted') {
      return false
    }
    const params = traexRecord(value)
    this.windowsSandbox.completed(
      params.requestId,
      params.success === true,
      traexText(params.error) ?? null
    )
    return true
  }

  async recap(command: StructuredAgentSessionCommandRun): Promise<void> {
    this.session.timeline!.beginCommand(command)
    try {
      await this.connection.request(
        'thread/recap',
        { threadId: this.session.threadId },
        {
          onReply: (value) => {
            this.pendingRecap = {
              command,
              providerTurnId: traexText(traexRecord(value).turnId) ?? null
            }
          }
        }
      )
    } catch (error) {
      this.failRecap(command, error)
      throw error
    }
  }

  private failRecap(command: StructuredAgentSessionCommandRun, error: unknown): void {
    this.pendingRecap = null
    this.finishRecapTurn(
      command,
      {
        kind: 'status',
        text: `Recap failed${error instanceof Error ? `: ${error.message}` : ''}.`,
        tone: 'warning'
      },
      false
    )
  }

  private finishRecap(params: Record<string, unknown>, ok: boolean): void {
    const pending = this.pendingRecap
    if (!pending) {
      return
    }
    const providerTurnId = traexText(params.turnId)
    if (pending.providerTurnId && providerTurnId !== pending.providerTurnId) {
      return
    }
    this.pendingRecap = null
    this.finishRecapTurn(
      pending.command,
      ok
        ? {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: traexText(params.text) ?? 'Recap unavailable.' }]
          }
        : { kind: 'status', text: 'Recap failed.', tone: 'warning' },
      ok
    )
  }

  private finishRecapTurn(
    command: StructuredAgentSessionCommandRun,
    body: ProviderTimelineItemBody,
    ok: boolean
  ): void {
    const thread = this.session.threadId
    if (!thread) {
      return
    }
    this.session.timeline?.apply({
      type: 'item.close',
      item: `recap:${command.turnId}`,
      body,
      join: { thread }
    })
    this.session.timeline?.apply({
      type: 'turn.end',
      at: Date.now(),
      state: 'completed',
      outcome: ok ? 'success' : 'failure'
    })
  }

  private observeRateLimits(snapshot: Record<string, unknown>): void {
    const weekly = traexRecord(snapshot.secondary)
    if (typeof weekly.usedPercent !== 'number' || weekly.usedPercent < 100) {
      return
    }
    const resetAt = typeof weekly.resetsAt === 'number' ? weekly.resetsAt : undefined
    const resetsAt = resetAt === undefined ? null : new Date(resetAt * 1000)
    this.session.timeline?.apply({
      type: 'item.close',
      item: `rate-limit:${resetAt ?? Date.now()}`,
      body: {
        kind: 'status',
        text:
          resetsAt && !Number.isNaN(resetsAt.getTime())
            ? `Weekly limit reached; resets ${resetsAt.toLocaleString()}`
            : 'Weekly limit reached',
        tone: 'warning'
      },
      join: { thread: this.session.threadId!, scope: { kind: 'thread' } }
    })
  }

  prepareWindowsSandbox(
    cwd: string,
    mode: TraexSession['launch']['permissionMode']
  ): Promise<void> {
    return this.windowsSandbox.prepare(cwd, mode)
  }

  warn(message: string, fields: StructuredAgentSessionLogFields): void {
    this.logger?.warn(message, fields)
  }

  dispose(): void {
    this.pendingRecap = null
    this.naming?.dispose()
    this.windowsSandbox.dispose()
  }
}
