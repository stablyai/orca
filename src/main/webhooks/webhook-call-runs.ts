// A hook's calls on its execution host: taken into the ledger before the delivery is acknowledged,
// then run through the same event path as every trigger. Outcomes stay in the ledger.
import { randomUUID } from 'node:crypto'
import {
  automationWebhookTrigger,
  type AutomationRunEvent,
  type AutomationRunWebhookCall
} from '../../shared/automation-event-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { ConnectorDelivery } from '../../shared/connectors/connector-cloud-contract'
import { hookIdOfRule } from '../../shared/connector-webhook-contract'
import type { WebhookEnvelope } from '../../shared/connector-webhook-routes'
import type { WebhookCallView } from '../../../cloud/packages/connector-contract/src/webhook-matcher'
import type { EventStartGate } from '../automations/automation-trigger-runs'
import { webhookCallQuote, webhookCallView, writeWebhookCallFile } from './webhook-call-file'
import type { ConnectorFailure } from '../connector-cloud/connector-cloud-request'
import type { WebhookCloudCalls } from './webhook-cloud-routes'
import type { LedgerCall, WebhookHostLedger } from './webhook-host-ledger'
import { WebhookStartSlots } from './webhook-start-slots'
import {
  settledRunOutcome,
  webhookRetryDelayMs,
  type WebhookCallOutcome
} from './webhook-call-outcomes'

type TriggerDelivery = Extract<ConnectorDelivery, { kind: 'trigger' }>

export type WebhookCallRoute =
  | { kind: 'automation'; automationId: string }
  | { kind: 'handled'; reason: string }

// A call the cloud can't place under the caps right now is offered again after this.
const START_RETRY_MS = 60_000

const isUnoffered = (call: LedgerCall) =>
  call.state === 'received' || call.state === 'waiting_capacity'

export type WebhookCallRunsDeps = {
  ledger: WebhookHostLedger
  cloud: WebhookCloudCalls
  automations: () => readonly Automation[]
  runs: (automationId: string) => readonly AutomationRun[]
  /** The bot's folder on this host, or null once the bot or its folder is gone. */
  botFolder: (botId: string) => string | null
  runForEvent: (
    automationId: string,
    event: AutomationRunEvent,
    gate: EventStartGate
  ) => Promise<AutomationRun | null>
  /**
   * A host-level hook's calls go to the automation they're for (another automation's id), or are
   * handled by the host and settle with `reason`. Null leaves the call with its own automation.
   */
  route?: (hookId: string, call: WebhookCallView) => Promise<WebhookCallRoute | null>
  now?: () => number
  setTimer?: (run: () => void, delayMs: number) => () => void
}

export class WebhookCallRuns {
  private readonly now: () => number
  private readonly setTimer: (run: () => void, delayMs: number) => () => void
  private readonly processing = new Set<string>()
  private readonly timers = new Map<string, () => void>()
  private readonly attempts = new Map<string, number>()
  private readonly slots = new WebhookStartSlots()

  constructor(private readonly deps: WebhookCallRunsDeps) {
    this.now = deps.now ?? Date.now
    this.setTimer =
      deps.setTimer ??
      ((run, delayMs) => {
        const timer = setTimeout(run, delayMs)
        timer.unref?.()
        return () => clearTimeout(timer)
      })
  }

  /**
   * Takes a call delivered for a hook's rule. Ours once it's in the ledger, so the delivery is
   * acknowledged then and a resend is a no-op. False refuses a call from an older hook generation.
   */
  receive(delivery: TriggerDelivery, event: AutomationRunEvent): boolean {
    const fields = delivery.event.webhook
    const hookId = hookIdOfRule(delivery.triggerId)
    if (!fields || !hookId) {
      return false
    }
    if (this.deps.ledger.call(fields.callId)) {
      return true
    }
    const hook = this.deps.ledger.hook(hookId)
    // Paused, deleted or revoked since.
    if (hook && fields.epoch < hook.epoch) {
      return false
    }
    const taken = this.deps.ledger.receive(
      {
        callId: fields.callId,
        hookId,
        automationId: delivery.automationId,
        triggerId: delivery.triggerId,
        occurredAt: event.occurredAt,
        ...(event.subject === undefined ? {} : { subject: event.subject }),
        epoch: fields.epoch,
        ...(fields.sample ? { sample: true as const } : {}),
        ...(!fields.sample && hook && !hook.called ? { first: true as const } : {})
      },
      this.now()
    )
    if (taken) {
      void this.process(fields.callId)
    }
    return taken
  }

  /** Offers every call not yet run again, as after a restart. */
  resume(): void {
    for (const call of this.deps.ledger.calls()) {
      if (isUnoffered(call)) {
        this.later(call.callId, Math.max(0, (call.retryAt ?? 0) - this.now()))
      }
    }
    this.sweep()
  }

  stop(): void {
    for (const cancel of this.timers.values()) {
      cancel()
    }
    this.timers.clear()
  }

  private later(callId: string, delayMs: number): void {
    this.timers.get(callId)?.()
    this.timers.set(
      callId,
      this.setTimer(() => {
        this.timers.delete(callId)
        void this.process(callId)
      }, delayMs)
    )
  }

  private retry(callId: string, failure: ConnectorFailure | null = null): void {
    const attempt = this.attempts.get(callId) ?? 0
    this.attempts.set(callId, attempt + 1)
    this.later(callId, webhookRetryDelayMs(attempt, failure))
  }

  private settle(callId: string, outcome: WebhookCallOutcome): void {
    this.attempts.delete(callId)
    this.deps.ledger.update(callId, outcome, this.now())
  }

  private async process(callId: string): Promise<void> {
    const call = this.deps.ledger.call(callId)
    if (!call || this.processing.has(callId) || !isUnoffered(call)) {
      return
    }
    this.processing.add(callId)
    try {
      if (!this.recovered(call)) {
        await this.offer(call)
      }
    } catch (error) {
      console.warn('[webhooks] a call could not be offered to its automation', error)
      this.retry(callId)
    } finally {
      this.processing.delete(callId)
    }
  }

  private async offer(taken: LedgerCall): Promise<void> {
    const envelope = await this.deps.cloud.envelope(taken.callId)
    if (!envelope) {
      // Signed out: the call waits here and is missed once its grace ends, as any event's would.
      this.retry(taken.callId)
      return
    }
    if (!envelope.ok) {
      if (envelope.status === 404 || envelope.status === 410) {
        // The cloud cancelled it (pause, delete, revoke) and no longer keeps its body.
        this.attempts.delete(taken.callId)
        this.deps.ledger.forget(taken.callId)
        return
      }
      this.retry(taken.callId, envelope)
      return
    }
    const call = await this.routed(taken, envelope.value)
    if (!call) {
      return
    }
    const target = this.deps.automations().find((entry) => entry.id === call.automationId)
    // Counted against the bot the call runs for, which a routed call names only now.
    const release = target?.bot ? await this.slots.take(target.bot.botId) : () => {}
    try {
      await this.start(call, target, envelope.value)
    } finally {
      release()
    }
  }

  /**
   * A host-level hook's call, bound once to the automation and rule it goes to, so admission,
   * recovery and history all name that automation; null when the host handled it.
   */
  private async routed(call: LedgerCall, value: WebhookEnvelope): Promise<LedgerCall | null> {
    const routed =
      !call.routed && this.deps.route
        ? await this.deps.route(call.hookId, webhookCallView(value))
        : null
    if (routed?.kind === 'handled') {
      this.settle(call.callId, { state: 'refused', reason: routed.reason })
      return null
    }
    if (routed?.kind !== 'automation') {
      return call
    }
    const target = this.deps.automations().find((entry) => entry.id === routed.automationId)
    const rule = target && automationWebhookTrigger(target)
    if (!rule) {
      this.settle(call.callId, { state: 'refused', reason: 'automation_not_listening' })
      return null
    }
    const binding = { automationId: routed.automationId, triggerId: rule.id, routed: true as const }
    this.deps.ledger.bind(call.callId, binding)
    return { ...call, ...binding }
  }

  private async start(
    call: LedgerCall,
    target: Automation | undefined,
    value: WebhookEnvelope
  ): Promise<void> {
    const rule = target && automationWebhookTrigger(target)
    const folder = target?.bot ? this.deps.botFolder(target.bot.botId) : null
    const webhook: AutomationRunWebhookCall = {
      hookId: call.hookId,
      callId: call.callId,
      file: null,
      ...(call.sample ? { sample: true as const } : {}),
      ...(call.first ? { firstCall: true as const } : {})
    }
    const event: AutomationRunEvent = {
      triggerId: call.triggerId,
      source: 'webhook',
      event: 'call',
      key: call.callId,
      ...(call.subject === undefined ? {} : { subject: call.subject }),
      occurredAt: call.occurredAt,
      text: webhookCallQuote(rule ?? {}, value),
      webhook
    }
    // Asked only when the call would start a new run, so a fold or a miss never counts toward the caps.
    const gate: { asked: 'no' | 'started' | 'held' } = { asked: 'no' }
    const run = await this.deps.runForEvent(call.automationId, event, {
      reserve: async () => {
        const runId = call.reservedRunId ?? randomUUID()
        if (!call.reservedRunId) {
          this.deps.ledger.bind(call.callId, { reservedRunId: runId })
        }
        const answer = await this.deps.cloud.start(call.callId, runId)
        if (answer?.ok && answer.value.started) {
          gate.asked = 'started'
          // Only a call whose run starts gets a file, so a held, folded or cancelled one leaves none.
          const file = folder ? writeWebhookCallFile(folder, call.callId, value) : null
          if (file) {
            this.deps.ledger.bind(call.callId, { file: file.path })
          }
          return { event: { ...event, webhook: { ...webhook, file: file?.name ?? null } }, runId }
        }
        gate.asked = 'held'
        if (answer && !answer.ok && (answer.status === 404 || answer.status === 410)) {
          // Cancelled or settled in the cloud since it was taken, as for its envelope.
          this.attempts.delete(call.callId)
          this.deps.ledger.forget(call.callId)
          return { retryAt: this.now() }
        }
        if (answer && !answer.ok && answer.error === 'started_for_another_run') {
          // Its one start went to a run this host has no record of: never a second.
          this.settle(call.callId, { state: 'unverifiable' })
          return { retryAt: this.now() }
        }
        const retryAt =
          answer?.ok && !answer.value.started ? answer.value.retryAt : this.now() + START_RETRY_MS
        if (answer?.ok) {
          this.settle(call.callId, { state: 'waiting_capacity', retryAt })
        }
        this.later(call.callId, Math.max(0, retryAt - this.now()))
        return { retryAt }
      },
      created: (made) => {
        try {
          this.deps.ledger.bindRun(call.callId, made.id, this.now())
        } catch (error) {
          // The reserved id still names it, so a replay finds this run rather than making another.
          console.warn('[webhooks] could not record the run a call started', error)
        }
      }
    })
    if (gate.asked === 'held') {
      return
    }
    if (!run) {
      this.settle(call.callId, { state: 'refused', reason: 'automation_not_listening' })
      return
    }
    const settled = settledRunOutcome(run)
    if (gate.asked === 'started') {
      this.settle(call.callId, settled ?? { state: 'started', runId: run.id })
      return
    }
    // Missed or refused like any event, or folded into the subject's open run (counted, not shown).
    this.settle(
      call.callId,
      settled && settled.state !== 'completed' && settled.state !== 'failed'
        ? settled
        : { state: 'folded', runId: run.id }
    )
  }

  /**
   * A call whose run was made before a crash settles from that run, found by the id reserved for it.
   * Without one, it is offered again under the same id, which the cloud grants only once.
   */
  private recovered(call: LedgerCall): boolean {
    const run =
      call.reservedRunId &&
      this.deps.runs(call.automationId).find((entry) => entry.id === call.reservedRunId)
    if (run) {
      this.settle(call.callId, settledRunOutcome(run) ?? { state: 'started', runId: run.id })
    }
    return Boolean(run)
  }

  /** Settles started and folded calls whose run has ended. */
  sweep(): void {
    for (const call of this.deps.ledger.calls()) {
      if ((call.state !== 'started' && call.state !== 'folded') || !call.runId) {
        continue
      }
      const run = this.deps.runs(call.automationId).find((entry) => entry.id === call.runId)
      // History keeps 100 runs; one gone before Orca saw it end can't be vouched for.
      const outcome = run ? settledRunOutcome(run) : { state: 'unverifiable' as const }
      if (outcome) {
        this.deps.ledger.update(call.callId, { ...outcome, runId: call.runId }, this.now())
      }
    }
  }
}
