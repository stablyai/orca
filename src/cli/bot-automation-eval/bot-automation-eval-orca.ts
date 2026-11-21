// The `orca` a benchmarked bot runs: the real CLI (help, parsing, validation, output) against a
// recorded stand-in host, so nothing reaches a real Orca.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import type { Automation } from '../../shared/automations/automation-definition'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  EVENT_ONLY_SCHEDULE,
  isWebhookTrigger,
  type AutomationEventTrigger
} from '../../shared/automation-event-triggers'
import { webhookRuleId } from '../../shared/connector-webhook-contract'
import { nextAutomationOccurrenceAfter } from '../../shared/automations/scheduling/automation-schedule-occurrences'
import { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import type { EvalHostState } from './bot-automation-eval-host'
import { refusedCommand } from './bot-automation-eval-refusals'
import {
  lookAroundCommandAllowed,
  LOOK_AROUND_REFUSAL
} from '../../main/bots/bot-look-around-policy'
import { serveOrchestration } from '../bot-orchestration-eval/bot-orchestration-eval-orca'
import { serveConnector } from './bot-automation-eval-connector'
import { installDeliveryUploads, serveDeliveries } from './bot-automation-eval-artifacts'
import { wakingThreadRef } from './bot-automation-eval-waking-thread'
import { serveOwnerLinear } from './bot-automation-eval-owner-linear'
import { serveBotConnectors } from './bot-automation-eval-bot-connectors'
import { serveEvalDecisionItem } from '../bot-orchestration-eval/bot-orchestration-eval-decision-item'
import { serveBots } from '../bot-orchestration-eval/bot-orchestration-eval-bots'
import {
  evalWorkRecord,
  evalWorkStorePath,
  recordEvalWorkerStart,
  serveEvalWork
} from '../bot-orchestration-eval/bot-orchestration-eval-work'
import {
  CONNECTOR_OFFER_SOURCES,
  googleOfferReply,
  connectorOfferReply,
  type ConnectorOfferSource
} from '../../shared/bots/bot-connector-offer'
import { googleBotConnectState } from '../../shared/google/google-bot-connect-state'

const statePath = process.env.ORCA_EVAL_STATE ?? ''
const logPath = process.env.ORCA_EVAL_LOG ?? ''
const invocation = { id: randomUUID(), argv: process.argv.slice(2) }

function readState(): EvalHostState {
  return JSON.parse(readFileSync(statePath, 'utf8'))
}

function record(entry: Record<string, unknown>): void {
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
}

installDeliveryUploads({ record })

function saved(state: EvalHostState, params: Record<string, unknown>, id: string): Automation {
  const now = Date.now()
  const automation: Automation = {
    id,
    name: '',
    prompt: '',
    precheck: null,
    agentId: 'claude',
    projectId: '',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: state.timezone,
    rrule: '',
    dtstart: now,
    enabled: true,
    nextRunAt: now,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 30,
    createdAt: now,
    updatedAt: now,
    ...Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined))
  }
  // The bot reads the next run back to check the schedule it wrote; a desktop host reads a named
  // zone, and its own clock otherwise.
  automation.nextRunAt =
    automation.dtstart === EVENT_ONLY_SCHEDULE.dtstart
      ? automation.dtstart
      : nextAutomationOccurrenceAfter(
          automation.rrule,
          automation.dtstart,
          now,
          automation.timezoneExplicit ? automation.timezone : undefined
        )
  return automation
}

// A host mints each new webhook's id when it saves the rule.
function withHookIds(on: unknown): unknown {
  if (!Array.isArray(on)) {
    return on
  }
  return on.map((rule: AutomationEventTrigger) =>
    isWebhookTrigger(rule) && !rule.id.startsWith('wh-')
      ? { ...rule, id: webhookRuleId(`wh_${randomBytes(8).toString('hex')}`) }
      : rule
  )
}

// The real CLI checked the source before calling.
function parseConnectorOfferSource(source: unknown): ConnectorOfferSource {
  const found = CONNECTOR_OFFER_SOURCES.find((entry) => entry === source)
  if (!found) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Offer one of: ${CONNECTOR_OFFER_SOURCES.join(', ')}`
    )
  }
  return found
}

function find(state: EvalHostState, id: unknown): Automation {
  const automation = state.automations.find((entry) => entry.id === id)
  if (!automation) {
    throw new RuntimeClientError('not_found', 'Automation not found.')
  }
  return automation
}

function serve(method: string, params: Record<string, unknown>): unknown {
  const state = readState()
  const io = {
    record,
    save: (next: EvalHostState) => writeFileSync(statePath, JSON.stringify(next))
  }
  if (state.decisionItem && (method === 'bots.items.set' || method === 'bots.items.comment')) {
    return serveEvalDecisionItem(state, method, params, io)
  }
  const bots = serveBots(state, method, params, io)
  if (bots !== undefined) {
    return bots
  }
  const orchestration = serveOrchestration(state, method, params, io)
  if (orchestration !== undefined) {
    return orchestration
  }
  const botConnectors = serveBotConnectors(state, method, params, io)
  if (botConnectors !== undefined) {
    return botConnectors
  }
  const linear = serveOwnerLinear(state, method, params, io)
  if (linear !== undefined) {
    return linear
  }
  const delivered = serveDeliveries(state, method, params, io, invocation)
  if (delivered !== undefined) {
    return delivered
  }
  const connector = serveConnector(state, method, params, io)
  if (connector !== undefined) {
    return connector
  }
  switch (method) {
    case 'status.get':
      return { capabilities: [] }
    case 'bots.list':
      return { bots: state.bots, webhooks: state.webhooks === true }
    case 'automation.list':
      return { automations: state.automations }
    case 'automation.show':
      return { automation: find(state, params.id) }
    case 'automation.create': {
      const automation = saved(
        state,
        { ...params, on: withHookIds(params.on) },
        `a${state.automations.length + 1}-0000-4000-8000-eval`
      )
      // With its id, so grading can fold the bot's own later edits of it into what it made.
      record({ kind: 'write', method, params, result: { id: automation.id } })
      state.automations.push(automation)
      writeFileSync(statePath, JSON.stringify(state))
      return { automation }
    }
    case 'automation.update': {
      record({ kind: 'write', method, params })
      const current = find(state, params.id)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real CLI built these updates from AutomationUpdateParams.
      const updates = params.updates as Record<string, unknown>
      // An absent field keeps its value, as on a real host.
      const changed = Object.entries(updates).filter(([, value]) => value !== undefined)
      const next = { ...current, ...Object.fromEntries(changed) }
      const automation = saved(state, { ...next, on: withHookIds(next.on) }, current.id)
      state.automations = state.automations.map((entry) =>
        entry.id === current.id ? automation : entry
      )
      writeFileSync(statePath, JSON.stringify(state))
      return { automation }
    }
    case 'automation.delete':
      record({ kind: 'write', method, params })
      find(state, params.id)
      state.automations = state.automations.filter((entry) => entry.id !== params.id)
      writeFileSync(statePath, JSON.stringify(state))
      return { removed: true, id: params.id }
    case 'connector.reply':
      record({ kind: 'write', method, params, result: { target: wakingThreadRef(state) } })
      return { status: 'posted' }
    case 'bots.connector.offer': {
      const bot = state.bots[0]!
      const source = parseConnectorOfferSource(params.source)
      // The stand-in bot has no Google and its computer no Google app.
      const answer: ReturnType<typeof connectorOfferReply> =
        source === 'google'
          ? googleOfferReply(
              googleBotConnectState({ allowed: false, client: null, accounts: [] }),
              { headless: false, botName: bot.name }
            )
          : connectorOfferReply(
              bot,
              source,
              typeof params.workspace === 'string' ? params.workspace : undefined
            )
      // As the host answers: the card's kind is not part of the reply.
      const { addAccess: _addAccess, ...reply } = answer
      // Only a card shown is an effect worth grading.
      if (reply.offered) {
        record({ kind: 'write', method, params })
      }
      return reply
    }
    case 'repo.list':
      return { repos: state.repos }
  }
  throw new RuntimeClientError('unsupported', `${method} is not available on this host.`)
}

// The work record: a started worker joins it; `bot work` reads it.
async function serveWithRecord(method: string, params: Record<string, unknown>): Promise<unknown> {
  const record = evalWorkRecord(readState, evalWorkStorePath(statePath))
  const work = await serveEvalWork(record, readState(), method)
  if (work !== undefined) {
    return work
  }
  const result = serve(method, params)
  if (method === 'orchestration.workerStart') {
    await recordEvalWorkerStart(record, readState(), result)
  }
  return result
}

RuntimeClient.prototype.call = async function call<TResult>(method: string, params?: unknown) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the CLI sends object params or none.
  const result = await serveWithRecord(method, (params ?? {}) as Record<string, unknown>)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stand-in answers in each method's shape.
  return { id: 'eval', ok: true, result: result as TResult, _meta: { runtimeId: 'eval' } }
}

// `status` reads the app's metadata directly; answer as a ready app so bots don't conclude it is down.
async function readyStatus(): ReturnType<RuntimeClient['getCliStatus']> {
  return {
    id: 'eval-status',
    ok: true,
    result: {
      target: { kind: 'local' },
      app: { running: true, pid: 1 },
      runtime: { state: 'ready', reachable: true, runtimeId: 'eval' },
      graph: { state: 'ready' }
    },
    _meta: { runtimeId: 'eval' }
  }
}
RuntimeClient.prototype.getCliStatus = readyStatus

const argv = invocation.argv
record({ kind: 'argv', argv, invocationId: invocation.id })
if (
  readState().lookAround &&
  !lookAroundCommandAllowed(['orca', ...argv].map((word) => `'${word}'`).join(' '))
) {
  process.stderr.write(`${LOOK_AROUND_REFUSAL}\n`)
  process.exit(1)
}
const refused = refusedCommand(argv)
if (refused) {
  process.stderr.write(`orca ${refused} is not available on this host.\n`)
  process.exit(1)
}
// Bundled, the CLI entry runs itself: it is the bundle's main module.
void import('../index.js')
