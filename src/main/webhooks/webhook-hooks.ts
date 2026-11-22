// A hook's life on its execution host: made when its automation is saved, kept paused or live with
// its automation, and deleted when its rule, automation or bot goes. The cloud is told until it says yes.
import { randomUUID } from 'node:crypto'
import {
  automationWebhookTrigger,
  webhookIsOnlyStart,
  isWebhookTrigger,
  type AutomationEventTrigger,
  type AutomationWebhookTrigger
} from '../../shared/automation-event-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import {
  hookIdOfRule,
  webhookRuleId,
  type WebhookFilters
} from '../../shared/connector-webhook-contract'
import type { WebhookView } from '../../shared/connector-webhook-routes'
import type { ConnectorFailure } from '../connector-cloud/connector-cloud-request'
import { webhookRetryDelayMs } from './webhook-call-outcomes'
import type { WebhookCloudCalls } from './webhook-cloud-routes'
import type { LedgerHook, WebhookHostLedger } from './webhook-host-ledger'

type HookChange = NonNullable<LedgerHook['change']>

// A create that never saved its automation; the cloud expires its pending hook after an hour anyway.
const STALE_INTENT_MS = 10 * 60 * 1000
const MINT_ATTEMPTS = 3

export const WEBHOOKS_UNSUPPORTED = "Orca Cloud doesn't support webhooks yet."
export const WEBHOOKS_NOT_CONNECTED =
  "This Orca isn't connected to Orca Cloud, so it can't make a webhook. Sign in to Orca and try again."

// The cloud's refusals at mint, in words the bot relays.
const MINT_REFUSALS: Record<string, string> = {
  account_webhook_cap: 'This account has 100 webhooks; delete one first.',
  host_webhook_cap: 'This computer has 50 webhooks; delete one first.',
  webhook_mint_rate: 'Too many webhooks were made in the last hour; try again later.',
  automation_has_webhook:
    'This automation already has a webhook in Orca Cloud; edit its filters instead of making another.',
  // The cloud hears of a bot's host from the hello, which may not have gone out yet.
  bot_not_on_host:
    "Orca Cloud doesn't yet know this bot is on this computer. Check that this Orca is signed in, wait a moment, and try again."
}

function mintRefusal(failure: ConnectorFailure): string {
  if (failure.status === 404 && failure.error === null) {
    return WEBHOOKS_UNSUPPORTED
  }
  return (
    (failure.error && MINT_REFUSALS[failure.error]) ??
    `Orca Cloud couldn't make the webhook (${failure.error ?? failure.status ?? 'unreachable'}).`
  )
}

const filtersOf = ({ where, textContains, pick, subjectFrom, subject }: WebhookFilters) =>
  JSON.stringify([where ?? [], textContains ?? '', pick ?? [], subjectFrom ?? '', subject ?? ''])

/** Drops the automation's webhook rule; an automation nothing else starts goes with it. */
export function dropWebhookRule<T>(
  automation: Automation,
  writes: {
    setTriggers: (id: string, on: AutomationEventTrigger[]) => T
    remove: (id: string) => T
  }
): T {
  return webhookIsOnlyStart(automation)
    ? writes.remove(automation.id)
    : writes.setTriggers(
        automation.id,
        (automation.on ?? []).filter((trigger) => !isWebhookTrigger(trigger))
      )
}

export type WebhookHooksDeps = {
  ledger: WebhookHostLedger
  cloud: WebhookCloudCalls
  automations: {
    list: () => readonly Automation[]
    setTriggers: (id: string, on: AutomationEventTrigger[]) => void
    remove: (id: string) => void
  }
  botExists: (botId: string) => boolean
  /** The cloud confirmed a pause, resume or delete. */
  confirmed?: () => void
  now?: () => number
}

// A 4xx other than a timeout, rate limit or expired session refuses the change itself.
function isPermanentRefusal(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500 && ![401, 408, 429].includes(status)
}

export class WebhookHooks {
  private readonly now: () => number
  private reconciling: Promise<void> | null = null
  private queued: Promise<void> | null = null
  // A change's next send, by operationId: backoff while the cloud doesn't answer.
  private readonly backoff = new Map<string, { attempt: number; at: number }>()

  constructor(private readonly deps: WebhookHooksDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * The rules to save, with a new webhook's draft (id '') made into its hook first. An edit keeps the
   * hook, so its URL; changed filters raise its rev. The operationId names a create to settle later.
   */
  async settle(input: {
    automationId: string
    botId: string
    current?: Automation
    next: readonly AutomationEventTrigger[]
  }): Promise<{ on: AutomationEventTrigger[]; operationId?: string }> {
    const wanted = input.next.find(isWebhookTrigger)
    if (!wanted) {
      return { on: [...input.next] }
    }
    const kept = input.current && automationWebhookTrigger(input.current)
    if (wanted.id && wanted.id !== kept?.id) {
      throw new Error("A webhook's id comes from Orca Cloud; leave it out to make a new one.")
    }
    const others = input.next.filter((trigger) => trigger !== wanted)
    if (kept) {
      const rev = filtersOf(wanted) === filtersOf(kept) ? kept.rev : kept.rev + 1
      return { on: [...others, { ...wanted, id: kept.id, rev }] }
    }
    const operationId = randomUUID()
    const hook = await this.mint(operationId, input.automationId, input.botId)
    const rule: AutomationWebhookTrigger = { ...wanted, id: webhookRuleId(hook.hookId), rev: 1 }
    return { on: [...others, rule], operationId }
  }

  private async mint(
    operationId: string,
    automationId: string,
    botId: string
  ): Promise<WebhookView> {
    this.deps.ledger.saveIntent({ operationId, automationId, botId, createdAt: this.now() })
    let failure: ConnectorFailure | null = null
    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
      // A lost answer is asked again with the same operationId, which mints once.
      const minted = await this.deps.cloud.mint({ operationId, automationId, botId })
      if (!minted) {
        this.deps.ledger.dropIntent(operationId)
        throw new Error(WEBHOOKS_NOT_CONNECTED)
      }
      if (minted.ok) {
        const hook = minted.value
        this.deps.ledger.saveIntent({
          operationId,
          automationId,
          botId,
          hookId: hook.hookId,
          createdAt: this.now()
        })
        this.remember(hook)
        return hook
      }
      failure = minted
      if (minted.status !== null && minted.status < 500) {
        break
      }
    }
    this.deps.ledger.dropIntent(operationId)
    throw new Error(failure ? mintRefusal(failure) : WEBHOOKS_UNSUPPORTED)
  }

  /** Records what the cloud said about one of this host's hooks. */
  remember(hook: WebhookView): void {
    this.deps.ledger.saveHook({
      hookId: hook.hookId,
      automationId: hook.automationId,
      botId: hook.botId,
      epoch: hook.epoch,
      // Orphaned is the cloud's view of a hello; this host lists the rule, so the next one clears it.
      state: hook.state === 'orphaned' ? 'live' : hook.state
    })
  }

  /** The automation was saved, so its create is settled; the next hello lists the rule and the hook goes live. */
  saved(operationId: string | undefined): void {
    if (operationId) {
      this.deps.ledger.dropIntent(operationId)
    }
  }

  /** The save failed after a mint: the hook goes on the next reconcile. */
  abandoned(operationId: string): void {
    this.deps.ledger.dropIntent(operationId)
    void this.reconcile()
  }

  /**
   * Brings the cloud in line with the automations here: each hook paused or live with its automation,
   * and deleted once nothing here lists it. Asked while running, it runs once more and settles after that.
   */
  reconcile(): Promise<void> {
    if (!this.reconciling) {
      this.reconciling = this.reconcileOnce()
        .catch((error: unknown) => console.warn('[webhooks] could not reconcile hooks', error))
        .finally(() => {
          this.reconciling = null
        })
      return this.reconciling
    }
    this.queued ??= this.reconciling.then(() => {
      this.queued = null
      return this.reconcile()
    })
    return this.queued
  }

  /** Sends every unconfirmed change now, as when the cloud is back. */
  retryNow(): Promise<void> {
    this.backoff.clear()
    return this.reconcile()
  }

  private async reconcileOnce(): Promise<void> {
    const wanted = new Map<string, 'live' | 'paused'>()
    for (const automation of this.deps.automations.list()) {
      const rule = automationWebhookTrigger(automation)
      const hookId = rule ? hookIdOfRule(rule.id) : null
      if (hookId && automation.bot && this.deps.botExists(automation.bot.botId)) {
        wanted.set(hookId, automation.enabled ? 'live' : 'paused')
      }
    }
    const now = this.now()
    const minting = new Set<string>()
    for (const intent of this.deps.ledger.intents()) {
      if (now - intent.createdAt > STALE_INTENT_MS) {
        this.deps.ledger.dropIntent(intent.operationId)
      } else if (intent.hookId) {
        minting.add(intent.hookId)
      }
    }
    // A drop replaces the ledger's list, so this one stays whole.
    for (const hook of this.deps.ledger.hooks()) {
      const state = wanted.get(hook.hookId)
      if (state && hook.state === 'pending') {
        const known = await this.deps.cloud.get(hook.hookId)
        if (known?.ok) {
          this.remember(known.value)
        }
      }
      await this.converge(hook.hookId, state ?? (minting.has(hook.hookId) ? null : 'deleted'))
    }
  }

  /** Sends the hook's unconfirmed change first, so a pause lands before a resume, then what it wants now. */
  private async converge(hookId: string, wanted: HookChange['state'] | null): Promise<void> {
    for (let step = 0; step < 2; step++) {
      const hook = this.deps.ledger.hook(hookId)
      const change = hook && (hook.change ?? this.changeFor(hook, wanted))
      if (!hook || !change) {
        return
      }
      if (!hook.change) {
        this.deps.ledger.setChange(hookId, change)
      }
      if (!(await this.send(hookId, change))) {
        return
      }
    }
  }

  private changeFor(hook: LedgerHook, wanted: HookChange['state'] | null): HookChange | undefined {
    const due =
      wanted === 'deleted' || (wanted && hook.state !== 'pending' && hook.state !== wanted)
    return due && wanted ? { state: wanted, operationId: randomUUID() } : undefined
  }

  /** One try at a change; false while it is to be sent again. */
  private async send(hookId: string, change: HookChange): Promise<boolean> {
    const backoff = this.backoff.get(change.operationId)
    if (backoff && backoff.at > this.now()) {
      return false
    }
    const answer =
      change.state === 'deleted'
        ? await this.deps.cloud.remove(hookId)
        : await this.deps.cloud.setState(hookId, {
            operationId: change.operationId,
            state: change.state
          })
    const done =
      answer?.ok ||
      (change.state === 'deleted' && (answer?.status === 404 || answer?.status === 410))
    if (!done && answer && !answer.ok && isPermanentRefusal(answer.status)) {
      // Sending it again gets the same answer; the next listing shows the cloud's state.
      console.warn(`[webhooks] the cloud refused a hook change (${answer.status})`)
    } else if (!done) {
      const attempt = backoff?.attempt ?? 0
      const delay = webhookRetryDelayMs(attempt, answer && !answer.ok ? answer : null)
      this.backoff.set(change.operationId, { attempt: attempt + 1, at: this.now() + delay })
      return false
    }
    this.backoff.delete(change.operationId)
    if (change.state === 'deleted') {
      this.deps.ledger.dropHook(hookId)
    } else {
      if (answer?.ok && answer.value) {
        this.remember(answer.value)
      }
      this.deps.ledger.setChange(hookId, undefined)
    }
    this.deps.confirmed?.()
    return true
  }

  /** Hooks deleted while this host was away: their rules go, and an automation with nothing else to start it goes too. */
  dropTombstoned(hookIds: readonly string[]): void {
    for (const hookId of hookIds) {
      const ruleId = webhookRuleId(hookId)
      const automation = this.deps.automations
        .list()
        .find((entry) => entry.on?.some((trigger) => trigger.id === ruleId))
      if (automation) {
        dropWebhookRule(automation, this.deps.automations)
      }
      this.deps.ledger.dropHook(hookId)
    }
  }
}
