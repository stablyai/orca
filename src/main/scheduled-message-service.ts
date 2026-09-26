import {
  isSameScheduledDelivery,
  MAX_SCHEDULED_MESSAGES_PER_WORKSPACE,
  SCHEDULED_MESSAGE_MAX_USAGE_LIMIT_WAIT_MS,
  SCHEDULED_MESSAGE_MISSED_GRACE_MS,
  SCHEDULED_MESSAGE_TICK_MS,
  scheduledMessageStatusForFailure,
  type ScheduledMessage,
  type ScheduledMessageChanges,
  type ScheduledMessageDraft,
  type ScheduledMessageFailureReason,
  type ScheduledMessagesSnapshot
} from '../shared/scheduled-message-types'
import {
  validateScheduledMessageDraft,
  validateScheduledMessageText,
  validateScheduledMessageTiming
} from '../shared/scheduled-message-validation'
import { resolveScheduledMessageDeliveryOutcome } from './scheduled-message-delivery-outcome'
import { pickDueMessages } from './scheduled-message-due-selection'
import { ScheduledMessageDeliveryState } from './scheduled-message-delivery-state'
import {
  confirmAgentStillIdle,
  pickNextIdleMessage,
  ScheduledMessageIdleTimers
} from './scheduled-message-idle-delivery'
import { ScheduledMessageTickLoop } from './scheduled-message-tick-loop'
import type { AgentIdleEdgeEvent } from './runtime/orca-runtime'
import {
  IDLE_EDGE_SETTLE_MS,
  type ScheduledMessagePaneTarget,
  type ScheduledMessageServiceOptions
} from './scheduled-message-service-contracts'

// Re-exported so callers keep importing the service and its ports from one
// place; the split exists only to keep this file under the line ceiling.
export * from './scheduled-message-service-contracts'

/** Delivers one-shot user messages into a workspace's agent pane. State is
 *  persisted: a queued message must survive a quit. */
export class ScheduledMessageService {
  private readonly opts: ScheduledMessageServiceOptions
  private readonly now: () => number
  private readonly logger: Pick<Console, 'debug' | 'warn'>
  private readonly missedGraceMs: number
  private readonly maxUsageLimitWaitMs: number
  private readonly idleSettleMs: number
  private readonly delivery = new ScheduledMessageDeliveryState()
  private readonly idleTimers = new ScheduledMessageIdleTimers()
  /** Status cannot stand in: a row stays `pending` for the whole send, so a second
   *  trigger would type the same text into the agent twice. */
  private readonly inFlight = new Set<string>()
  private readonly loop: ScheduledMessageTickLoop
  private disposed = false

  constructor(options: ScheduledMessageServiceOptions) {
    this.opts = options
    this.now = options.now ?? Date.now
    this.logger = options.logger ?? console
    this.missedGraceMs = options.missedGraceMs ?? SCHEDULED_MESSAGE_MISSED_GRACE_MS
    this.maxUsageLimitWaitMs =
      options.maxUsageLimitWaitMs ?? SCHEDULED_MESSAGE_MAX_USAGE_LIMIT_WAIT_MS
    this.idleSettleMs = options.idleSettleMs ?? IDLE_EDGE_SETTLE_MS
    this.loop = new ScheduledMessageTickLoop(
      () => this.evaluateDue(),
      options.tickMs ?? SCHEDULED_MESSAGE_TICK_MS,
      this.logger
    )
  }

  start(): void {
    this.loop.start()
  }

  dispose(): void {
    this.disposed = true
    this.loop.dispose()
    this.idleTimers.dispose()
  }

  add(draft: ScheduledMessageDraft): ScheduledMessage {
    const error = validateScheduledMessageDraft(draft, this.now())
    if (error) {
      throw new Error(error)
    }
    const pending = this.opts.store
      .listScheduledMessages()
      .filter((message) => message.worktreeId === draft.worktreeId)
    if (pending.length >= MAX_SCHEDULED_MESSAGES_PER_WORKSPACE) {
      throw new Error('too-many-scheduled-messages')
    }
    const message: ScheduledMessage = {
      id: this.opts.createId(),
      worktreeId: draft.worktreeId,
      text: draft.text,
      timing: draft.timing,
      createdAt: this.now(),
      status: 'pending'
    }
    this.opts.store.putScheduledMessage(message)
    this.emitSnapshot()
    return message
  }

  /** Also the reschedule path: giving a `missed`/`failed` row a future time
   *  returns it to `pending` and clears its spent attempt budget. */
  update(messageId: string, changes: ScheduledMessageChanges): void {
    const existing = this.find(messageId)
    if (!existing) {
      throw new Error('scheduled-message-not-found')
    }
    const edited = {
      ...existing,
      text: changes.text ?? existing.text,
      timing: changes.timing ?? existing.timing
    }
    // Validate before touching delivery state: a rejected edit must leave the row
    // exactly as it was, credit included.
    const error =
      validateScheduledMessageText(edited.text) ??
      (changes.timing ? validateScheduledMessageTiming(changes.timing, this.now()) : null)
    if (error) {
      throw new Error(error)
    }
    if (changes.timing) {
      this.delivery.forgetDeferrals(messageId)
      // A row retimed to a clock moment must not keep the settle timer an idle
      // edge armed for it — that timer would deliver it early, at the old timing.
      this.idleTimers.clear(messageId)
    }
    this.opts.store.putScheduledMessage(this.revived(edited))
    this.emitSnapshot()
  }

  remove(messageId: string): void {
    this.delivery.forget(messageId)
    this.idleTimers.clear(messageId)
    this.opts.store.deleteScheduledMessage(messageId)
    this.emitSnapshot()
  }

  /** Manual override for a row the user is looking at — bypasses the schedule but
   *  not the send guards, so it still cannot type into a shell. */
  async sendNow(messageId: string): Promise<void> {
    const message = this.find(messageId)
    if (!message) {
      throw new Error('scheduled-message-not-found')
    }
    // Return a failed/missed row to pending first, or the identity check below
    // reads it as "no longer pending" and drops the send on the floor.
    const pending = this.revived(message)
    // A timer an idle edge armed would otherwise re-send the text afterwards, or
    // resurrect a row the user meant to be done with.
    this.idleTimers.clear(messageId)
    this.opts.store.putScheduledMessage(pending)
    // Emit first: a defer or retry writes nothing more, and the tab would keep the failed label.
    this.emitSnapshot()
    await this.attemptDelivery(pending)
  }

  /** Back to pending with a clean slate. */
  private revived(message: ScheduledMessage): ScheduledMessage {
    this.delivery.forgetAttempts(message.id)
    const next: ScheduledMessage = { ...message, status: 'pending' }
    delete next.failureReason
    return next
  }

  getSnapshot(): ScheduledMessagesSnapshot {
    return { messages: this.opts.store.listScheduledMessages() }
  }

  private async evaluateDue(): Promise<void> {
    if (this.disposed) {
      return
    }
    const now = this.now()
    const due = pickDueMessages(this.opts.store.listScheduledMessages(), now)
    for (const { message, sendAt } of due) {
      if (this.disposed) {
        return
      }
      // Past the grace window the agent's context has moved on; the row survives
      // so the user can send it themselves.
      if (now - sendAt - this.delivery.deferredMs(message.id, now) > this.missedGraceMs) {
        this.markFailed(message, 'expired-while-closed')
        continue
      }
      await this.attemptDelivery(message)
    }
  }

  /** Wired to the runtime's live agent-idle edge. */
  handleIdleEdge(event: AgentIdleEdgeEvent): void {
    if (this.disposed) {
      return
    }
    const next = pickNextIdleMessage(this.opts.store.listScheduledMessages(), event.worktreeId)
    if (!next || this.idleTimers.has(next.id)) {
      return
    }
    this.idleTimers.arm(next.id, this.idleSettleMs, () => {
      // Re-read: the settle window is long enough for the user to retime the row
      // to a clock moment, which this edge no longer speaks for.
      const current = this.find(next.id)
      if (current?.status === 'pending' && current.timing.kind === 'when-idle') {
        void this.attemptDelivery(current, true)
      }
    })
  }

  private async attemptDelivery(
    message: ScheduledMessage,
    requireIdleAgent = false
  ): Promise<void> {
    if (this.inFlight.has(message.id)) {
      return
    }
    this.inFlight.add(message.id)
    try {
      await this.deliverOnce(message, requireIdleAgent)
    } finally {
      this.inFlight.delete(message.id)
    }
  }

  private async deliverOnce(message: ScheduledMessage, requireIdleAgent: boolean): Promise<void> {
    const pane = await this.resolvePaneSafely(message)
    if (this.disposed || !this.isStillDeliverable(message)) {
      return
    }
    if (!pane) {
      this.markFailed(message, 'no-pane')
      return
    }
    // Leave the row pending rather than failing it: the agent took work back up
    // inside the settle window, and the next idle edge arms this again.
    if (
      requireIdleAgent &&
      !(await confirmAgentStillIdle(this.opts.isAgentIdle, pane, this.logger))
    ) {
      this.logger.debug('[scheduled-messages] agent is working again, waiting for the next idle', {
        messageId: message.id
      })
      return
    }
    if (this.disposed || !this.isStillDeliverable(message)) {
      return
    }
    // Defer, do not fail: at a usage-limit banner this text would land in the
    // CLI's own prompt.
    if (pane.ptyId !== null && (await this.opts.deferForUsageLimit(pane.ptyId, pane.handle))) {
      // deferForUsageLimit can press keys at a chooser, so an edit lands inside it.
      if (this.disposed || !this.isStillDeliverable(message)) {
        return
      }
      const now = this.now()
      this.delivery.beginDeferral(message.id, now)
      // A limit that outlasts the ceiling has taken the message past the point
      // where sending it is a favour to anyone; tell the user instead.
      if (this.delivery.deferredMs(message.id, now) > this.maxUsageLimitWaitMs) {
        this.markFailed(message, 'usage-limit-outlasted')
        return
      }
      this.logger.debug('[scheduled-messages] deferring, pane is usage-limit stalled', {
        messageId: message.id
      })
      return
    }
    this.delivery.endDeferral(message.id, this.now())
    // `stillWanted` repeats this at the write: the guard's probe waits up to a
    // second, and an IPC edit lands inside it.
    if (this.disposed || !this.isStillDeliverable(message)) {
      return
    }
    try {
      await this.opts.deliver(pane.handle, message.text, {
        requireIdleAgent,
        stillWanted: () => this.isStillDeliverable(message)
      })
    } catch (error) {
      if (this.disposed || !this.isStillDeliverable(message)) {
        return
      }
      this.onDeliveryError(message, error)
      return
    }
    if (!this.isStillDeliverable(message)) {
      return
    }
    this.delivery.forget(message.id)
    this.idleTimers.clear(message.id)
    this.opts.store.deleteScheduledMessage(message.id)
    this.opts.notify?.({ kind: 'sent', worktreeId: message.worktreeId, messageId: message.id })
    this.emitSnapshot()
  }

  private async resolvePaneSafely(
    message: ScheduledMessage
  ): Promise<ScheduledMessagePaneTarget | null> {
    try {
      return await this.opts.resolveAgentPane(message.worktreeId)
    } catch (error) {
      this.logger.debug('[scheduled-messages] pane resolution failed', {
        messageId: message.id,
        error
      })
      return null
    }
  }

  private onDeliveryError(message: ScheduledMessage, error: unknown): void {
    const outcome = resolveScheduledMessageDeliveryOutcome(
      error,
      this.delivery.attemptsFor(message.id)
    )
    if (outcome.kind === 'retry') {
      if (outcome.spendsAttempt) {
        this.delivery.recordAttempt(message.id)
      }
      return
    }
    if (outcome.loud) {
      this.logger.warn('[scheduled-messages] delivery failed', { messageId: message.id, error })
    }
    this.markFailed(message, outcome.reason)
  }

  private markFailed(message: ScheduledMessage, reason: ScheduledMessageFailureReason): void {
    const status = scheduledMessageStatusForFailure(reason)
    this.delivery.forget(message.id)
    this.idleTimers.clear(message.id)
    this.opts.store.putScheduledMessage({ ...message, status, failureReason: reason })
    this.opts.notify?.({
      kind: status,
      worktreeId: message.worktreeId,
      messageId: message.id,
      failureReason: reason
    })
    this.emitSnapshot()
  }

  private isStillDeliverable(message: ScheduledMessage): boolean {
    const current = this.find(message.id)
    return current?.status === 'pending' && isSameScheduledDelivery(current, message)
  }

  private find(messageId: string): ScheduledMessage | undefined {
    return this.opts.store.listScheduledMessages().find((entry) => entry.id === messageId)
  }

  private emitSnapshot(): void {
    this.opts.onSnapshot?.(this.getSnapshot())
  }
}
