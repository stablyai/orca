// This host's webhooks: its hooks' lifecycle, its calls' runs, and the reads the card, row and
// `orca webhooks` make. Everything runs here, on the bot's execution host, never on a viewer.
import {
  matchesWebhookCall,
  type WebhookFilters
} from '../../../cloud/packages/connector-contract/src/webhook-matcher'
import {
  automationWebhookTrigger,
  type AutomationEventTrigger,
  type AutomationRunEvent
} from '../../shared/automation-event-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { Bot } from '../../shared/bot-types'
import type { ConnectorDelivery } from '../../shared/connectors/connector-cloud-contract'
import { hookIdOfRule } from '../../shared/connector-webhook-contract'
import { fenceQuotedText } from '../../shared/quoted-text-fence'
import type {
  WebhookCallRow,
  WebhookCheckResult,
  WebhookKey,
  WebhookSecretParams,
  WebhookSummary
} from '../../shared/rpc-contract/webhooks-params'
import type { EventStartGate } from '../automations/automation-trigger-runs'
import type { ConnectorCloud } from '../connector-cloud/connector-cloud'
import type { ConnectorResult } from '../connector-cloud/connector-cloud-request'
import { webhookCallView } from './webhook-call-file'
import { WebhookRecoverySweep } from './webhook-recovery-sweep'
import { WebhookCallRuns, type WebhookCallRunsDeps } from './webhook-call-runs'
import { webhookCloudCalls, webhookSummary, type WebhookCloudCalls } from './webhook-cloud-routes'
import { WebhookHooks } from './webhook-hooks'
import { webhookNoticeText } from './webhook-notice-text'
import { WebhookHostLedger } from './webhook-host-ledger'
import { orcaCloudNeedsSignIn } from '../../shared/bots/host-orca-sign-in'

type TriggerDelivery = Extract<ConnectorDelivery, { kind: 'trigger' }>

const CLOUD_WEBHOOKS_FEATURE = 'webhooks'
const CHECK_CALLS = 50
const CHECK_FETCHES_AT_ONCE = 4

/** What the automation controller asks of webhooks when it saves an automation. */
export type AutomationWebhooks = Pick<
  WebhookHostService,
  'advertised' | 'signedOut' | 'settle' | 'saved' | 'abandoned'
>

export type WebhookHostServiceDeps = {
  userDataPath: string
  account: () => string | null
  cloud: () =>
    | (Pick<ConnectorCloud, 'call' | 'cloudFeatures' | 'withConnection'> &
        Partial<Pick<ConnectorCloud, 'status'>>)
    | null
  automations: {
    list: () => readonly Automation[]
    runs: (automationId: string) => readonly AutomationRun[]
    setTriggers: (id: string, on: AutomationEventTrigger[]) => void
    remove: (id: string) => void
  }
  botFolder: (botId: string) => string | null
  /** Every bot's folder on this host, for the call-file sweep. */
  botFolders: () => readonly string[]
  botExists: (botId: string) => boolean
  bot: (botId: string) => Bot | undefined
  /** The bot's "couldn't finish" notification, on this computer and paired phones; never an agent turn. */
  notifyOwner: (
    bot: Bot,
    automation: Pick<Automation, 'name'>,
    notice: { title: string; body: string }
  ) => void
  runForEvent: (
    automationId: string,
    event: AutomationRunEvent,
    gate: EventStartGate
  ) => Promise<AutomationRun | null>
  /** For tests: the routes, instead of the connector's. */
  routes?: WebhookCloudCalls
}

/** A failed read, as one of WEBHOOK_ERROR_CODES. */
function unwrap<T>(result: ConnectorResult<T> | null): T {
  if (!result) {
    throw new Error('webhooks_unavailable')
  }
  if (!result.ok) {
    throw new Error(
      result.status === 404 && result.error !== null ? 'webhook_not_found' : 'webhooks_unavailable'
    )
  }
  return result.value
}

export class WebhookHostService {
  private readonly ledger: WebhookHostLedger
  private readonly routes: WebhookCloudCalls
  private readonly hooks: WebhookHooks
  private readonly runs: WebhookCallRuns
  private readonly sweep: WebhookRecoverySweep
  private readonly confirmedListeners = new Set<() => void>()
  private router: WebhookCallRunsDeps['route'] | null = null

  constructor(private readonly deps: WebhookHostServiceDeps) {
    this.ledger = new WebhookHostLedger(deps.userDataPath, deps.account)
    this.routes = deps.routes ?? webhookCloudCalls(deps.cloud)
    this.hooks = new WebhookHooks({
      ledger: this.ledger,
      cloud: this.routes,
      automations: deps.automations,
      botExists: deps.botExists,
      confirmed: () => {
        for (const listener of this.confirmedListeners) {
          listener()
        }
      }
    })
    this.runs = new WebhookCallRuns({
      ledger: this.ledger,
      cloud: this.routes,
      automations: deps.automations.list,
      runs: deps.automations.runs,
      botFolder: deps.botFolder,
      runForEvent: deps.runForEvent,
      route: (hookId, call) => this.router?.(hookId, call) ?? Promise.resolve(null)
    })
    this.sweep = new WebhookRecoverySweep({
      ledger: this.ledger,
      settleRuns: () => this.runs.sweep(),
      reconcileHooks: () => void this.hooks.reconcile(),
      botFolders: deps.botFolders
    })
  }

  /** A host-level hook's router (Composio's events hook); one at a time. */
  setCallRouter(router: WebhookCallRunsDeps['route'] | null): void {
    this.router = router
  }

  /** One recovery pass now, resolved once done; the sweep timer runs only while something is left to recover. */
  start(): Promise<void> {
    this.runs.resume()
    void this.hooks.reconcile()
    return this.sweep.start()
  }

  stop(): void {
    this.runs.stop()
    this.sweep.stop()
  }

  /** Signed out of Orca, so no event or webhook call reaches this host's bots. */
  signedOut(): boolean {
    return orcaCloudNeedsSignIn(this.deps.cloud()?.status?.())
  }

  /** Whether this host's Orca Cloud takes webhooks; until a hello says, assume it does and let the mint decide. */
  advertised(): boolean {
    return this.deps.cloud()?.cloudFeatures()?.has(CLOUD_WEBHOOKS_FEATURE) ?? true
  }

  /** A hello was answered: drop hooks deleted while this host was away. */
  helloAnswered(answer: { webhookTombstones?: string[] }): void {
    this.hooks.dropTombstoned(answer.webhookTombstones ?? [])
    if (this.advertised()) {
      void this.hooks.retryNow()
    }
  }

  /** The cloud confirmed a pause, resume or delete, so the hello's rules change. */
  onConfirmed(listener: () => void): void {
    this.confirmedListeners.add(listener)
  }

  /** A paused automation's hook stays in the hello until the cloud confirms the pause. */
  pausing(hookId: string): boolean {
    const hook = this.ledger.hook(hookId)
    return hook !== undefined && hook.state !== 'paused'
  }

  /** Whether the hook's pause, resume or delete is still unconfirmed once this host has tried. */
  async lifecyclePending(hookId: string): Promise<boolean> {
    await this.hooks.reconcile()
    return this.ledger.hook(hookId)?.change !== undefined
  }

  /** An automation, run or bot changed. */
  changed(): void {
    void this.hooks.reconcile().then(() => this.sweep.arm())
    this.runs.sweep()
  }

  /** A notice about one of this host's hooks, under the bot's "couldn't finish" switch. */
  notice(delivery: Extract<ConnectorDelivery, { kind: 'webhook_notice' }>): boolean {
    const automation = this.deps.automations.list().find((entry) => {
      const rule = automationWebhookTrigger(entry)
      return (
        rule && hookIdOfRule(rule.id) === delivery.hookId && entry.bot?.botId === delivery.botId
      )
    })
    if (!automation) {
      return false
    }
    const bot = this.deps.bot(delivery.botId)
    if (bot) {
      this.deps.notifyOwner(bot, automation, webhookNoticeText(delivery, automation, bot.name))
    }
    return true
  }

  receive(delivery: TriggerDelivery, event: AutomationRunEvent): boolean {
    const taken = this.runs.receive(delivery, event)
    this.sweep.arm()
    return taken
  }

  // Each of these changes what is left to recover, so the sweep timer follows.
  async settle(...args: Parameters<WebhookHooks['settle']>): ReturnType<WebhookHooks['settle']> {
    try {
      return await this.hooks.settle(...args)
    } finally {
      this.sweep.arm()
    }
  }

  saved(operationId: string | undefined): void {
    this.hooks.saved(operationId)
    this.sweep.arm()
  }

  abandoned(operationId: string): void {
    this.hooks.abandoned(operationId)
    void this.hooks.reconcile().then(() => this.sweep.arm())
  }

  /** The automation that lists the hook here; anything else isn't this host's to read. */
  /** Every automation on this host, as the hooks see them. */
  automations(): readonly Automation[] {
    return this.deps.automations.list()
  }

  automationOf(hookId: string): Automation {
    const automation = this.deps.automations.list().find((entry) => {
      const rule = automationWebhookTrigger(entry)
      return rule !== undefined && hookIdOfRule(rule.id) === hookId
    })
    if (!automation) {
      throw new Error('webhook_not_found')
    }
    return automation
  }

  async list(botId: string): Promise<WebhookSummary[]> {
    const { hooks } = unwrap(await this.routes.list(botId))
    const here = new Map(
      this.deps.automations.list().flatMap((automation) => {
        const rule = automationWebhookTrigger(automation)
        return rule ? [[hookIdOfRule(rule.id), automation] as const] : []
      })
    )
    return hooks.flatMap((hook) => {
      const automation = here.get(hook.hookId)
      return automation ? [webhookSummary(hook, automation)] : []
    })
  }

  async card(hookId: string): Promise<WebhookSummary> {
    const automation = this.automationOf(hookId)
    const hook = unwrap(await this.routes.get(hookId))
    this.hooks.remember(hook)
    return webhookSummary(hook, automation)
  }

  /** The cloud's verdicts, with what this host did with each call it took. */
  async calls(hookId: string): Promise<WebhookCallRow[]> {
    const automation = this.automationOf(hookId)
    const { calls } = unwrap(await this.routes.calls(hookId))
    return calls.map((row) => {
      if (row.kind !== 'call') {
        return row
      }
      const ours = this.ledger.call(row.callId)
      const state = ours && ours.state !== 'received' ? ours.state : undefined
      const mine = state ? ours : undefined
      const runId = mine?.runId ?? row.runId
      // A routed call's run is in the automation it was routed to.
      const runs = this.deps.automations.runs(ours?.automationId ?? automation.id)
      const runNumber = runId ? runs.find((run) => run.id === runId)?.runNumber : undefined
      return {
        ...row,
        ...(state ? { state } : {}),
        ...(runId ? { runId } : {}),
        ...(runNumber === undefined ? {} : { runNumber }),
        ...(mine?.reason ? { reason: mine.reason } : {})
      }
    })
  }

  /** The key, for Orca's UI alone. */
  async reveal(hookId: string): Promise<WebhookKey> {
    this.automationOf(hookId)
    const hook = unwrap(await this.routes.get(hookId))
    const { key } = unwrap(await this.routes.reveal(hookId, {}))
    return { key, url: `${hook.url}/${key}` }
  }

  /** One call, fenced as the caller's words. */
  async callText(hookId: string, callId: string): Promise<{ callId: string; text: string }> {
    this.automationOf(hookId)
    const envelope = unwrap(await this.routes.envelope(callId))
    return { callId, text: fenceQuotedText(JSON.stringify(envelope, null, 2)) }
  }

  /** How the filters, or the hook's own, sort the calls the cloud still keeps. */
  async check(hookId: string, filters?: WebhookFilters): Promise<WebhookCheckResult> {
    const rule = automationWebhookTrigger(this.automationOf(hookId))
    const { calls } = unwrap(await this.routes.calls(hookId))
    const ids = calls
      .flatMap((row) => (row.kind === 'call' ? [row.callId] : []))
      .slice(0, CHECK_CALLS)
    const result: WebhookCheckResult = { matched: 0, unmatched: 0, unknown: 0 }
    for (let index = 0; index < ids.length; index += CHECK_FETCHES_AT_ONCE) {
      const envelopes = await Promise.all(
        ids
          .slice(index, index + CHECK_FETCHES_AT_ONCE)
          .map(async (id) => await this.routes.envelope(id))
      )
      for (const envelope of envelopes) {
        if (!envelope?.ok || envelope.value.truncated) {
          result.unknown++
        } else if (matchesWebhookCall(filters ?? rule ?? {}, webhookCallView(envelope.value))) {
          result.matched++
        } else {
          result.unmatched++
        }
      }
    }
    return result
  }

  async sample(hookId: string, operationId: string): Promise<{ callId: string }> {
    this.automationOf(hookId)
    return unwrap(await this.routes.sample(hookId, operationId))
  }

  async rotate(
    hookId: string,
    body: { operationId: string; stopNow: boolean }
  ): Promise<{ cancelledCalls: number }> {
    this.automationOf(hookId)
    return unwrap(await this.routes.rotate(hookId, body))
  }

  async setSecret({ hookId, ...body }: WebhookSecretParams): Promise<{ secret?: string }> {
    this.automationOf(hookId)
    return unwrap(await this.routes.setSecret(hookId, body))
  }
}
