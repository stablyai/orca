import { randomUUID } from 'node:crypto'
import type { OrchestrationDb } from './db'
import type {
  ConversationWakeProvider,
  ConversationWakeTarget,
  ConversationWakeTurnRequest
} from './conversation-wake-provider'
import type { ConversationWakeJobRow } from './conversation-wake-state'

const DEFAULT_RETRY_BASE_MS = 1_000
const DEFAULT_RETRY_MAX_MS = 30_000
const DEFAULT_RETRY_ATTEMPTS = 5
const DEFAULT_ACCEPTANCE_LEASE_MS = 30_000
const MAX_ID_LENGTH = 512

export type ConversationWakeJobProcessorOptions = {
  db: OrchestrationDb
  providers: ReadonlyMap<string, ConversationWakeProvider>
  isEnabled: () => boolean
  now: () => number
  scheduleNextRetry: () => void
  onError?: (error: unknown) => void
  retryBaseMs?: number
  retryMaxMs?: number
  retryMaxAttempts?: number
  acceptanceLeaseMs?: number
}

export class ConversationWakeJobProcessor {
  constructor(private readonly options: ConversationWakeJobProcessorOptions) {}

  async process(wakeId: string): Promise<void> {
    if (!this.options.isEnabled()) {
      return
    }
    const job = this.options.db.getConversationWakeJob(wakeId)
    if (
      !job ||
      !['pending', 'waiting_for_idle', 'retry_wait', 'submitting', 'accepted'].includes(job.status)
    ) {
      return
    }
    const provider = this.options.providers.get(job.provider)
    if (!provider) {
      if (job.status === 'accepted') {
        this.options.db.markConversationWakeJobInconsistent(
          wakeId,
          'provider adapter unavailable for durably accepted turn'
        )
      } else {
        this.options.db.markConversationWakeJobBlocked(wakeId, 'provider adapter unavailable')
      }
      return
    }
    if (job.status === 'accepted') {
      await this.finalizeAcceptedJob(job, provider)
      return
    }
    if (!this.options.db.isConversationWakeJobUnread(wakeId)) {
      this.options.db.markConversationWakeJobCancelled(wakeId, 'mailbox message was consumed')
      return
    }
    const binding = this.options.db.getConversationWakeBinding(job.run_id)
    if (
      !binding ||
      binding.status !== 'active' ||
      binding.consumer_generation !== job.consumer_generation ||
      binding.provider !== job.provider ||
      binding.conversation_id !== job.conversation_id
    ) {
      this.options.db.markConversationWakeJobBlocked(wakeId, 'conversation ownership fenced')
      return
    }
    const target: ConversationWakeTarget = {
      runId: job.run_id,
      consumerGeneration: job.consumer_generation,
      conversationId: job.conversation_id
    }
    let state
    try {
      state = await provider.getState(target)
    } catch (error) {
      this.recordFailure(job.wake_id, error, true)
      return
    }
    if (!this.options.isEnabled()) {
      return
    }
    if (state === 'active') {
      this.options.db.markConversationWakeJobWaiting(wakeId, 'turn active')
      return
    }
    if (state === 'missing' || state === 'unsupported') {
      this.options.db.markConversationWakeJobBlocked(wakeId, `provider ${state}`)
      return
    }
    await this.submitIdleJob(job, provider)
  }

  private async submitIdleJob(
    job: ConversationWakeJobRow,
    provider: ConversationWakeProvider
  ): Promise<void> {
    const now = this.options.now()
    const acceptanceLease = randomUUID()
    const claimed = this.options.db.claimConversationWakeJob({
      wakeId: job.wake_id,
      acceptanceLease,
      leaseExpiresAt: now + (this.options.acceptanceLeaseMs ?? DEFAULT_ACCEPTANCE_LEASE_MS),
      now
    })
    if (!claimed) {
      if (!this.options.db.isConversationWakeJobUnread(job.wake_id)) {
        this.options.db.markConversationWakeJobCancelled(
          job.wake_id,
          'mailbox message was consumed'
        )
      }
      return
    }
    if (!this.options.isEnabled()) {
      return
    }
    const request = buildTurnRequest(claimed, null, (providerTurnId) => {
      if (!this.options.isEnabled() || !isBoundedId(providerTurnId)) {
        return false
      }
      return this.options.db.commitConversationWakeAcceptance({
        wakeId: job.wake_id,
        acceptanceLease,
        providerTurnId,
        now: this.options.now()
      })
    })
    try {
      const result = await provider.prepareAndFinalizeTurn(request)
      const committed = this.options.db.getConversationWakeJob(job.wake_id)
      if (result.status === 'finalized') {
        if (committed?.status !== 'accepted' || committed.provider_turn_id !== result.turnId) {
          this.options.db.markConversationWakeJobInconsistent(
            job.wake_id,
            'provider finalized a turn that does not match durable acceptance'
          )
        } else {
          this.options.db.confirmConversationWakeFinalized({
            wakeId: job.wake_id,
            providerTurnId: result.turnId
          })
        }
        return
      }
      if (committed?.status === 'accepted') {
        this.options.db.markConversationWakeJobInconsistent(
          job.wake_id,
          'provider reported stale after durable acceptance'
        )
        return
      }
      if (committed?.status === 'submitting') {
        if (!this.options.db.isConversationWakeJobUnread(job.wake_id)) {
          this.options.db.markConversationWakeJobCancelled(
            job.wake_id,
            'mailbox message was consumed'
          )
        } else {
          this.recordFailure(
            job.wake_id,
            new Error('provider rejected stale acceptance lease'),
            false
          )
        }
      }
    } catch (error) {
      if (this.options.db.getConversationWakeJob(job.wake_id)?.status === 'accepted') {
        this.recordAcceptedFailure(job.wake_id, error, false)
      } else if (this.options.db.getConversationWakeJob(job.wake_id)?.status !== 'submitted') {
        this.recordFailure(job.wake_id, error, false)
      }
    }
  }

  private async finalizeAcceptedJob(
    job: ConversationWakeJobRow,
    provider: ConversationWakeProvider
  ): Promise<void> {
    if (!job.provider_turn_id) {
      this.options.db.markConversationWakeJobInconsistent(
        job.wake_id,
        'accepted wake lacks a provider turn ID'
      )
      return
    }
    try {
      const result = await provider.prepareAndFinalizeTurn(
        buildTurnRequest(job, job.provider_turn_id, () => false)
      )
      if (result.status !== 'finalized' || result.turnId !== job.provider_turn_id) {
        this.options.db.markConversationWakeJobInconsistent(
          job.wake_id,
          'provider recovery did not finalize the durably accepted turn'
        )
        return
      }
      if (
        !this.options.db.confirmConversationWakeFinalized({
          wakeId: job.wake_id,
          providerTurnId: result.turnId
        })
      ) {
        this.options.db.markConversationWakeJobInconsistent(
          job.wake_id,
          'durable acceptance changed before provider finalization confirmation'
        )
      }
    } catch (error) {
      this.recordAcceptedFailure(job.wake_id, error, true)
    }
  }

  private recordAcceptedFailure(wakeId: string, error: unknown, incrementAttempt: boolean): void {
    const retry = this.retry(error, wakeId, incrementAttempt)
    this.options.db.scheduleConversationWakeAcceptedRecovery({
      wakeId,
      reason: retry.reason,
      nextAttemptAt: retry.nextAttemptAt,
      maxAttempts: this.options.retryMaxAttempts ?? DEFAULT_RETRY_ATTEMPTS,
      incrementAttempt
    })
    this.options.onError?.(error)
    this.options.scheduleNextRetry()
  }

  private recordFailure(wakeId: string, error: unknown, incrementAttempt: boolean): void {
    const retry = this.retry(error, wakeId, incrementAttempt)
    this.options.db.scheduleConversationWakeRetry({
      wakeId,
      reason: retry.reason,
      nextAttemptAt: retry.nextAttemptAt,
      maxAttempts: this.options.retryMaxAttempts ?? DEFAULT_RETRY_ATTEMPTS,
      incrementAttempt
    })
    this.options.onError?.(error)
    this.options.scheduleNextRetry()
  }

  private retry(
    error: unknown,
    wakeId: string,
    incrementAttempt: boolean
  ): { reason: string; nextAttemptAt: number } {
    const reason = error instanceof Error ? error.message : String(error)
    const current = this.options.db.getConversationWakeJob(wakeId)
    const nextAttempt = (current?.attempt_count ?? 0) + (incrementAttempt ? 1 : 0)
    const delay = Math.min(
      (this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS) * 2 ** Math.max(nextAttempt - 1, 0),
      this.options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS
    )
    return { reason, nextAttemptAt: this.options.now() + delay }
  }
}

function buildTurnRequest(
  job: ConversationWakeJobRow,
  acceptedTurnId: string | null,
  commitPrepared: (providerTurnId: string) => boolean
): ConversationWakeTurnRequest {
  return {
    runId: job.run_id,
    consumerGeneration: job.consumer_generation,
    conversationId: job.conversation_id,
    wakeId: job.wake_id,
    idempotencyKey: `orca-orchestration-wake:${job.wake_id}`,
    messageId: job.message_id,
    messageType: job.message_type,
    taskId: job.task_id,
    dispatchId: job.dispatch_id,
    acceptedTurnId,
    prompt:
      'Orca committed a supervised orchestration event. Check the durable mailbox for the bound Run and continue without inferring acknowledgment from this wake.',
    commitPrepared
  }
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}
