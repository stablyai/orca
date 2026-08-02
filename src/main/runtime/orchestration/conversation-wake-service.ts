import type { MessageRow } from './types'
import type { OrchestrationDb } from './db'
import type { ConversationWakeProvider } from './conversation-wake-provider'
import { ConversationWakeJobProcessor } from './conversation-wake-job-processor'

const ELIGIBLE_TYPES = new Set(['worker_done', 'escalation', 'decision_gate', 'question'])
const MAX_ID_LENGTH = 512

export type ConversationWakeServiceOptions = {
  db: OrchestrationDb
  providers: readonly ConversationWakeProvider[]
  isFeatureEnabled?: () => boolean
  isKillSwitchOpen?: () => boolean
  onError?: (error: unknown) => void
  now?: () => number
  retryBaseMs?: number
  retryMaxMs?: number
  retryMaxAttempts?: number
  acceptanceLeaseMs?: number
}

export class ConversationWakeService {
  private readonly providers: Map<string, ConversationWakeProvider>
  private readonly jobProcessor: ConversationWakeJobProcessor
  private readonly unsubscribers: (() => void)[] = []
  private readonly queues = new Map<string, Promise<void>>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(private readonly options: ConversationWakeServiceOptions) {
    this.providers = new Map(options.providers.map((provider) => [provider.id, provider]))
    this.jobProcessor = new ConversationWakeJobProcessor({
      db: options.db,
      providers: this.providers,
      isEnabled: () => this.isEnabled(),
      now: () => this.now(),
      scheduleNextRetry: () => this.scheduleNextRetry(),
      onError: options.onError,
      retryBaseMs: options.retryBaseMs,
      retryMaxMs: options.retryMaxMs,
      retryMaxAttempts: options.retryMaxAttempts,
      acceptanceLeaseMs: options.acceptanceLeaseMs
    })
    for (const provider of options.providers) {
      const unsubscribe = provider.onTurnTerminal((conversationId) => {
        void this.reconcileConversation(provider.id, conversationId).catch((error) =>
          this.options.onError?.(error)
        )
      })
      if (typeof unsubscribe !== 'function') {
        throw new Error(`Conversation wake provider ${provider.id} lacks a terminal subscription`)
      }
      this.unsubscribers.push(unsubscribe)
    }
  }

  async bindTarget(params: {
    runId: string
    consumerGeneration: number
    provider: string
    conversationId: string
  }): Promise<ReturnType<OrchestrationDb['bindConversationWakeTarget']>> {
    if (!this.providers.has(params.provider)) {
      throw new Error(`Unsupported conversation wake provider: ${params.provider}`)
    }
    if (!isBoundedId(params.conversationId)) {
      throw new Error('Invalid conversation wake conversation ID')
    }
    const result = this.options.db.bindConversationWakeTarget(params)
    if (this.isEnabled()) {
      this.backfill(params.runId)
      await this.reconcileConversation(params.provider, params.conversationId)
    }
    return result
  }

  async onMessageCommitted(message: MessageRow): Promise<void> {
    if (!this.isEnabled() || !isEligibleMessage(message)) {
      return
    }
    const queued = this.options.db.enqueueConversationWakeJob(message.id)
    if (!queued || queued.job.status === 'blocked') {
      return
    }
    await this.enqueueConversation(queued.job.provider, queued.job.conversation_id, () =>
      this.jobProcessor.process(queued.job.wake_id)
    )
    this.scheduleNextRetry()
  }

  async reconcile(): Promise<void> {
    this.clearRetryTimer()
    if (!this.isEnabled()) {
      return
    }
    for (const provider of this.providers.values()) {
      await provider.reconcile?.()
    }
    this.backfill()
    const now = this.now()
    for (const job of this.options.db.listProcessableConversationWakeJobs(now)) {
      await this.enqueueConversation(job.provider, job.conversation_id, () =>
        this.jobProcessor.process(job.wake_id)
      )
    }
    this.scheduleNextRetry()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.clearRetryTimer()
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe()
    }
    await Promise.all(
      [...this.providers.values()].map((provider) => Promise.resolve(provider.dispose?.()))
    )
  }

  private backfill(runId?: string): void {
    for (const message of this.options.db.listConversationWakeBackfillMessages(runId)) {
      this.options.db.enqueueConversationWakeJob(message.id)
    }
  }

  private async reconcileConversation(provider: string, conversationId: string): Promise<void> {
    if (!this.isEnabled()) {
      return
    }
    this.backfill()
    const jobs = this.options.db
      .listProcessableConversationWakeJobs(this.now())
      .filter((job) => job.provider === provider && job.conversation_id === conversationId)
    for (const job of jobs) {
      await this.enqueueConversation(provider, conversationId, () =>
        this.jobProcessor.process(job.wake_id)
      )
    }
    this.scheduleNextRetry()
  }

  private scheduleNextRetry(): void {
    this.clearRetryTimer()
    if (!this.isEnabled()) {
      return
    }
    const nextAttemptAt = this.options.db.getNextConversationWakeAttemptAt()
    if (nextAttemptAt === null) {
      return
    }
    const delay = Math.max(nextAttemptAt - this.now(), 0)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.reconcile().catch((error) => this.options.onError?.(error))
    }, delay)
    this.retryTimer.unref?.()
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private enqueueConversation(
    provider: string,
    conversationId: string,
    operation: () => Promise<void>
  ): Promise<void> {
    const key = `${provider}\u0000${conversationId}`
    const prior = this.queues.get(key) ?? Promise.resolve()
    const current = prior.catch(() => {}).then(operation)
    this.queues.set(key, current)
    return current.finally(() => {
      if (this.queues.get(key) === current) {
        this.queues.delete(key)
      }
    })
  }

  private isEnabled(): boolean {
    return (
      !this.disposed &&
      (this.options.isFeatureEnabled?.() ?? false) &&
      (this.options.isKillSwitchOpen?.() ?? true)
    )
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

function isEligibleMessage(message: MessageRow): boolean {
  return (
    message.delivery_contract === 'current_delivery' &&
    message.to_handle === `run:${message.run_id}` &&
    ELIGIBLE_TYPES.has(message.type) &&
    !hasLifecycleRejection(message.payload)
  )
}

function hasLifecycleRejection(payload: string | null): boolean {
  try {
    const parsed: unknown = payload ? JSON.parse(payload) : null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false
    }
    const marker = (parsed as Record<string, unknown>)._orcaLifecycleRejection
    return Boolean(
      marker &&
      typeof marker === 'object' &&
      !Array.isArray(marker) &&
      typeof (marker as Record<string, unknown>).code === 'string' &&
      typeof (marker as Record<string, unknown>).reason === 'string'
    )
  } catch {
    return false
  }
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}
