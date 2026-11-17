import type { TraexSession } from './traex-session'
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
    if (method === 'account/rateLimits/updated') {
      this.observeRateLimits(traexRecord(params.rateLimits))
      return true
    }
    if (method === 'windowsSandbox/setupCompleted') {
      this.windowsSandbox.completed(
        traexRecord(params).requestId,
        params.success === true,
        traexText(params.error) ?? null
      )
      return true
    }
    return false
  }

  private observeRateLimits(snapshot: Record<string, unknown>): void {
    const weekly = traexRecord(snapshot.secondary)
    if (typeof weekly.usedPercent !== 'number' || weekly.usedPercent < 100) {
      return
    }
    const resetsAt = typeof weekly.resetsAt === 'number' ? new Date(weekly.resetsAt * 1000) : null
    this.session.timeline?.apply({
      type: 'item.close',
      item: `rate-limit:${weekly.resetsAt ?? Date.now()}`,
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
    this.naming?.dispose()
    this.windowsSandbox.dispose()
  }
}
