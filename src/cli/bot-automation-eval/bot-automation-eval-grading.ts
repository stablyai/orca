// How a benchmark turn is graded: the automation the bot wrote, or the question it asked.
import { isGoogleTrigger } from '../../shared/automation-google-triggers'
import { parseAutomationEventTrigger } from '../automations/automation-event-trigger-spec'
import {
  EVENT_ONLY_SCHEDULE,
  type AutomationEventTrigger
} from '../../shared/automation-event-triggers'
import { nextAutomationOccurrenceAfter } from '../../shared/automations/scheduling/automation-schedule-occurrences'
import type {
  Automation,
  AutomationBotResultsTo
} from '../../shared/automations/automation-definition'
import {
  EVAL_BOT,
  type EvalHostState,
  type EvalOutcome,
  type EvalWrite
} from './bot-automation-eval-host'

export type EvalCategory =
  | 'slack'
  | 'github'
  | 'linear'
  | 'schedule'
  | 'mixed'
  | 'filters'
  | 'results-to'
  | 'ask'
  | 'no-automation'
  | 'edit'
  | 'tools'

export type EvalScenario = {
  id: string
  category: EvalCategory
  message: string
  automations?: Automation[]
  /** Merged over the default stand-in state. */
  state?: Partial<EvalHostState>
  /** The bot's MEMORY.md. */
  memory?: string
  /** Turns in the same Chat before the graded one, each on the host as it was then; the graded
   *  turn sees `state` again. */
  earlier?: { message: string; state?: Partial<EvalHostState> }[]
  /** Failures; empty passes. */
  grade: (outcome: EvalOutcome) => string[]
}

export type ExpectedTrigger = {
  on: string
  in?: string[]
  /** Absent: the trigger must not filter on text. */
  contains?: RegExp
  subject?: string
}

export type ExpectedSchedule = { hour: number; minute: number; days: number[] }

export const WEEKDAYS = [1, 2, 3, 4, 5]
export const EVERY_DAY = [0, ...WEEKDAYS, 6]

function sameSet(a: readonly string[] = [], b: readonly string[] = []): boolean {
  return a.length === b.length && a.every((entry) => b.includes(entry))
}

/** The repository or team a subject ("owner/name#482", "ENG-123") is in. */
function placeOf(subject: string): string {
  return subject.includes('#') ? subject.split('#')[0]! : subject.replace(/-\d+$/, '')
}

function triggerMatches(actual: AutomationEventTrigger, expected: ExpectedTrigger): boolean {
  if (isGoogleTrigger(actual)) {
    return false
  }
  const listensIn = actual.source === 'webhook' ? [] : (actual.in ?? [])
  // Naming the subject's own repository or team beside it narrows nothing.
  const redundant =
    !expected.in &&
    expected.subject !== undefined &&
    sameSet(listensIn, [placeOf(expected.subject)])
  return (
    `${actual.source}.${actual.event}` === expected.on &&
    sameSet(redundant ? [] : listensIn, expected.in) &&
    (expected.contains
      ? expected.contains.test(actual.textContains ?? '')
      : actual.textContains === undefined) &&
    actual.subject === expected.subject
  )
}

export function gradeTriggers(
  actual: AutomationEventTrigger[] | undefined,
  expected: ExpectedTrigger[],
  optional: ExpectedTrigger[] = []
): string[] {
  const triggers = actual ?? []
  const shown = JSON.stringify(triggers.map(({ id: _id, ...rest }) => rest))
  return [
    ...expected
      .filter((want) => !triggers.some((have) => triggerMatches(have, want)))
      .map((want) => `missing trigger ${JSON.stringify(want)}; got ${shown}`),
    ...triggers
      .filter((have) => ![...expected, ...optional].some((want) => triggerMatches(have, want)))
      .map((have) => `unexpected trigger ${formatTrigger(have)}`)
  ]
}

export function formatTrigger(trigger: AutomationEventTrigger): string {
  const { id: _id, ...rest } = trigger
  return JSON.stringify(rest)
}

export function gradeSchedule(rrule: unknown, dtstart: unknown, expected: ExpectedSchedule | null) {
  if (typeof rrule !== 'string' || typeof dtstart !== 'number') {
    return expected ? ['no schedule'] : []
  }
  if (!expected) {
    return dtstart === EVENT_ONLY_SCHEDULE.dtstart ? [] : [`unexpected schedule ${rrule}`]
  }
  if (dtstart === EVENT_ONLY_SCHEDULE.dtstart) {
    return ['no schedule']
  }
  let after = Date.now()
  for (let index = 0; index < 8; index += 1) {
    after = nextAutomationOccurrenceAfter(rrule, dtstart, after)
    const at = new Date(after)
    if (
      at.getHours() !== expected.hour ||
      at.getMinutes() !== expected.minute ||
      !expected.days.includes(at.getDay())
    ) {
      return [`schedule ${rrule} runs at ${at.toString()}`]
    }
    after += 60_000
  }
  return []
}

export type ExpectedCreate = {
  triggers?: ExpectedTrigger[]
  optionalTriggers?: ExpectedTrigger[]
  schedule?: ExpectedSchedule
  /** Where results go; several when each is a fair reading of the request. Chat by default. */
  resultsTo?: AutomationBotResultsTo | AutomationBotResultsTo[]
  runsIn?: 'new' | 'chat'
  /** Judgement the run must make, in the prompt rather than a filter. */
  prompt?: RegExp[]
}

function createdId(write: EvalWrite): unknown {
  const { result } = write
  return typeof result === 'object' && result !== null && 'id' in result ? result.id : undefined
}

/** The one automation the bot made, with its own later edits of it folded in: what it ends up as. */
export function onlyCreate(outcome: EvalOutcome): EvalWrite | string {
  const creates = outcome.writes.filter((write) => write.method === 'automation.create')
  const id = creates.length === 1 ? createdId(creates[0]!) : undefined
  const edits = outcome.writes.filter(
    (write) => write.method === 'automation.update' && id !== undefined && write.params.id === id
  )
  if (creates.length !== 1 || outcome.writes.length !== 1 + edits.length) {
    return `expected one create, got ${outcome.writes.map((write) => write.method).join(', ') || 'no writes'}`
  }
  const params = edits.reduce<Record<string, unknown>>((made, edit) => {
    const updates = edit.params.updates
    const changed =
      typeof updates === 'object' && updates !== null
        ? Object.entries(updates).filter(([, value]) => value !== undefined)
        : []
    return { ...made, ...Object.fromEntries(changed) }
  }, creates[0]!.params)
  return { ...creates[0]!, params }
}

export function expectCreate(expected: ExpectedCreate) {
  return (outcome: EvalOutcome): string[] => {
    const create = onlyCreate(outcome)
    if (typeof create === 'string') {
      return [create]
    }
    const { params } = create
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real CLI wrote these params.
    const bot = params.bot as { botId: string; runsIn: string; resultsTo: AutomationBotResultsTo }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real CLI parsed each --on.
    const on = params.on as AutomationEventTrigger[] | undefined
    const prompt = String(params.prompt ?? '')
    return [
      ...(bot?.botId === EVAL_BOT.id ? [] : ['not created as the bot']),
      ...gradeTriggers(on, expected.triggers ?? [], expected.optionalTriggers),
      ...gradeSchedule(params.rrule, params.dtstart, expected.schedule ?? null),
      ...([expected.resultsTo ?? 'chat']
        .flat()
        .some((place) => JSON.stringify(place) === JSON.stringify(bot?.resultsTo))
        ? []
        : [`results to ${JSON.stringify(bot?.resultsTo)}`]),
      ...(bot?.runsIn === (expected.runsIn ?? 'new') ? [] : [`runs in ${bot?.runsIn}`]),
      ...(expected.prompt ?? [])
        .filter((pattern) => !pattern.test(prompt))
        .map((pattern) => `prompt lacks ${pattern}: ${prompt.slice(0, 200)}`)
    ]
  }
}

const ASKS = /\?|\b(I need|tell me|let me know|paste|share|reply with|send)\b/i

/** No automation written, and the reply asks something matching `about`. */
export function expectQuestion(about: RegExp) {
  return (outcome: EvalOutcome): string[] => [
    ...(outcome.writes.length
      ? [`wrote ${outcome.writes.map((write) => write.method).join(', ')}`]
      : []),
    ...(ASKS.test(outcome.reply) ? [] : ['did not ask']),
    ...(about.test(outcome.reply) ? [] : [`reply does not mention ${about}`])
  ]
}

export function expectNoWrites(outcome: EvalOutcome): string[] {
  return outcome.writes.length
    ? [`wrote ${outcome.writes.map((write) => write.method).join(', ')}`]
    : []
}

export function existing(
  id: string,
  name: string,
  fields: { on?: string[]; rrule?: string; prompt: string }
): Automation {
  const now = Date.now()
  return {
    id,
    name,
    prompt: fields.prompt,
    precheck: null,
    agentId: 'claude',
    bot: { botId: EVAL_BOT.id, runsIn: 'new', resultsTo: 'chat' },
    ...(fields.on ? { on: fields.on.map(parseAutomationEventTrigger) } : {}),
    projectId: '',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    rrule: fields.rrule ?? EVENT_ONLY_SCHEDULE.rrule,
    dtstart: fields.rrule ? now - 86_400_000 : EVENT_ONLY_SCHEDULE.dtstart,
    enabled: true,
    nextRunAt: now,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 30,
    createdAt: now,
    updatedAt: now
  }
}

export const DEPLOY_PINGS = existing('5d1c2a40-0000-4000-8000-000000000001', 'Deploy pings', {
  on: ['slack.mentioned in=C0123ABCD contains=deploy'],
  prompt: 'Answer the deploy question.'
})
export const MORNING_SUMMARY = existing(
  '5d1c2a40-0000-4000-8000-000000000002',
  'Morning PR summary',
  {
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    prompt: 'Summarize my open pull requests.'
  }
)
export const ISSUE_TRIAGE = existing('5d1c2a40-0000-4000-8000-000000000003', 'Issue triage', {
  on: ['github.issue_opened'],
  prompt: 'Triage the new issue: label it and say whether it is a bug.'
})

function onlyUpdate(outcome: EvalOutcome, id: string): Record<string, unknown> | string {
  const writes = outcome.writes
  if (writes.length !== 1 || writes[0]!.method !== 'automation.update') {
    return `expected one edit, got ${writes.map((write) => write.method).join(', ') || 'no writes'}`
  }
  if (writes[0]!.params.id !== id) {
    return `edited ${String(writes[0]!.params.id)}`
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real CLI wrote `updates`.
  return writes[0]!.params.updates as Record<string, unknown>
}

export function expectEdit(id: string, check: (updates: Record<string, unknown>) => string[]) {
  return (outcome: EvalOutcome): string[] => {
    const updates = onlyUpdate(outcome, id)
    return typeof updates === 'string' ? [updates] : check(updates)
  }
}
