// The CLI side of bot automations' event triggers: --on, --trigger none, and trigger-options.
import {
  EVENT_ONLY_SCHEDULE,
  type AutomationEventTrigger
} from '../../shared/automation-event-triggers'
import {
  formatAutomationTriggerOptions,
  offeredEvents,
  offeredEventSources,
  parseAutomationEventSource,
  parseAutomationEventTrigger
} from './automation-event-trigger-spec'
import type { CommandHandler } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import { getOptionalStringFlag, getRepeatedStringFlag } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'
import type { RuntimeClient } from '../runtime/client'
import { getScheduleFlag } from './automation-handler-flags'
import { callBots, findBot, type BotsListResult } from '../bots/bot'
import { botEventSources, wontFireNote } from '../../shared/bot-event-sources'
import type { AutomationListPayload } from './automation-format'
import type { AutomationOnce } from '../../shared/automation-once'
import { orcaCloudNeedsSignIn } from '../../shared/bots/host-orca-sign-in'

type Flags = Map<string, string | boolean>

export const AUTOMATION_EVENT_TRIGGER_HANDLERS: Record<string, CommandHandler> = {
  // The same on every host, so it answers without one unless --bot asks which connectors a bot has.
  'automations trigger-options': async ({ flags, client, json }) => {
    const source = parseAutomationEventSource(getOptionalStringFlag(flags, 'source'))
    const selector = getOptionalStringFlag(flags, 'bot')
    const bot = selector ? await findBot(client, selector) : undefined
    const events = Object.fromEntries(
      offeredEventSources(source, bot).map((offered) => [offered, offeredEvents(offered, bot)])
    )
    // The guide carries the notes a bot needs; JSON callers read it too.
    const guide = formatAutomationTriggerOptions(source, bot)
    const result = {
      events,
      ...(bot ? { connected: botEventSources(bot) } : {}),
      guide
    }
    printResult({ id: 'local', ok: true, result, _meta: { runtimeId: 'local' } }, json, () => guide)
  }
}

/** Each --on is one trigger; `--on none` (edit) removes them all. Undefined when absent. */
export function getEventTriggersFlag(flags: Flags): AutomationEventTrigger[] | undefined {
  if (!flags.has('on')) {
    return undefined
  }
  const specs = getRepeatedStringFlag(flags, 'on')
  if (specs.length === 0) {
    throw new RuntimeClientError('invalid_argument', '--on needs an event, such as slack.mentioned')
  }
  if (specs.includes('none')) {
    if (specs.length > 1) {
      throw new RuntimeClientError('invalid_argument', '--on none cannot be combined with events')
    }
    return []
  }
  const triggers = new Map(specs.map(parseAutomationEventTrigger).map((t) => [t.id, t]))
  return [...triggers.values()]
}

/** With --on, the schedule is optional; without one the automation keeps a schedule no Orca reaches. */
export function getCreateScheduleFlag(
  flags: Flags,
  on: AutomationEventTrigger[] | undefined,
  once?: AutomationOnce
): { rrule: string; dtstart: number } {
  // A wait's only time is its --by.
  const startsWithoutSchedule = Boolean(on?.length) || once?.by !== undefined
  const schedule = getScheduleFlag(flags, !startsWithoutSchedule)
  if (schedule) {
    return schedule
  }
  if (!startsWithoutSchedule) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --trigger')
  }
  return { ...EVENT_ONLY_SCHEDULE }
}

/** `--trigger none` on edit leaves only the automation's events to start it. */
export function getEditScheduleFlag(flags: Flags): { rrule: string; dtstart: number } | undefined {
  const raw = getOptionalStringFlag(flags, 'trigger') ?? getOptionalStringFlag(flags, 'schedule')
  if (raw !== 'none') {
    return getScheduleFlag(flags, false)
  }
  if (flags.has('time') || flags.has('day')) {
    throw new RuntimeClientError('invalid_argument', '--time and --day need a schedule')
  }
  return { ...EVENT_ONLY_SCHEDULE }
}

/** The listing with why each bot automation's event rules never fire, when any can't. */
export async function withWontFire<Listed extends { result: AutomationListPayload }>(
  client: RuntimeClient,
  listed: Listed
): Promise<Listed> {
  const withRules = listed.result.automations.filter(
    (automation) => automation.bot && automation.on?.length
  )
  if (withRules.length === 0) {
    return listed
  }
  const { bots, webhooks, connectorStatus, signInServer } = await callBots<BotsListResult>(
    client,
    'bots.list'
  ).then(
    ({ result }) => result,
    (): BotsListResult => ({ bots: [], threadReplies: false })
  )
  const notes = withRules.flatMap(({ id, bot: target, on }) => {
    // A deleted bot's automation runs nowhere; the listing says nothing more about its rules.
    const bot = bots.find((entry) => entry.id === target?.botId)
    const note =
      bot &&
      wontFireNote(
        {
          ...bot,
          webhooks,
          cloudSignedOut: orcaCloudNeedsSignIn(connectorStatus),
          ...(signInServer !== undefined ? { signInServer } : {})
        },
        on ?? []
      )
    return note ? [[id, note] as const] : []
  })
  return notes.length > 0
    ? { ...listed, result: { ...listed.result, wontFire: Object.fromEntries(notes) } }
    : listed
}
