import type { CommandHandler } from '../dispatch/dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { callerChat } from '../automations/automation-caller-chat'
import { callBots, findBot } from './bot'
import type { BotLookAround, UpNextState } from '../../shared/bots/bot-look-around'
import { lookAroundScheduleText, lookAroundZone } from '../../shared/bots/bot-look-around-times'

/** An older host drops custom times and zones it doesn't know but saves the rest of the edit, so
 *  ask before sending anything. Any other failure (a host still starting) is reported as it is. */
async function assertCustomSchedules(
  client: Parameters<typeof callBots>[0],
  botId: string | undefined
): Promise<void> {
  try {
    await callBots(client, 'bots.lookAround.get', { ...callerChat(), ...(botId ? { botId } : {}) })
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'unsupported',
        'This host’s Orca can’t set custom Look around times or a time zone. Update Orca there first. Nothing was changed.'
      )
    }
    throw error
  }
}

/** `--at 09:30,14:00`: the times as given; the host checks them. */
function atTimes(value: string | undefined): string[] | undefined {
  return value === undefined
    ? undefined
    : value
        .split(',')
        .map((time) => time.trim())
        .filter(Boolean)
}

/** "Wed, Nov 11, 2:00 PM" on this machine's clock. */
function when(at: number): string {
  return new Date(at).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** What `show` prints: the schedule, its zone, and when the next look is and why. */
export function lookAroundShowText(value: { setting: BotLookAround; upNext: UpNextState }): string {
  const { setting, upNext } = value
  if (!setting.on) {
    return `Look around is off. When on: ${lookAroundScheduleText(setting)}.`
  }
  const lines = [
    `${lookAroundScheduleText(setting)}.`,
    `Times are in ${upNext.timeZone ?? 'the host’s time zone'}${lookAroundZone(setting) ? '' : ' (the host’s clock)'}.`,
    upNext.nextAt !== undefined
      ? `Next look: ${when(upNext.nextAt)}.`
      : 'Next look: a few hours after the first conversation.'
  ]
  if (upNext.nextSkipped) {
    lines.push(
      `The look at ${when(upNext.nextSkipped.at)} is skipped: one started at ${when(upNext.nextSkipped.lookedAt)}.`
    )
  }
  if (setting.focus) {
    lines.push(`Looks for: ${setting.focus}`)
  }
  return lines.join('\n')
}

/** `--on` / `--off` style pairs; both at once is a mistake, not a choice. */
function choice(
  flags: Map<string, string | boolean>,
  yes: string,
  no: string
): boolean | undefined {
  const on = flags.get(yes) === true
  const off = flags.get(no) === true
  if (on && off) {
    throw new RuntimeClientError('invalid_argument', `Use --${yes} or --${no}, not both`)
  }
  return on ? true : off ? false : undefined
}

export const BOT_LOOK_AROUND_HANDLERS: Record<string, CommandHandler> = {
  'bot suggest': async ({ flags, client, json }) => {
    const link = getOptionalStringFlag(flags, 'link')
    const result = await callBots<{ suggestion: { id: string; title: string } }>(
      client,
      'bots.suggest',
      {
        ...callerChat(),
        title: getRequiredStringFlag(flags, 'title'),
        why: getRequiredStringFlag(flags, 'why'),
        ask: getRequiredStringFlag(flags, 'ask'),
        ...(link ? { link } : {})
      }
    )
    printResult(result, json, (value) => `Suggested: ${value.suggestion.title}`)
  },
  'bot look-around set': async ({ flags, client, json }) => {
    const selector = getOptionalStringFlag(flags, 'bot')
    const botId = selector ? (await findBot(client, selector)).id : undefined
    const every = getOptionalStringFlag(flags, 'every')
    const focus = flags.get('focus')
    const on = choice(flags, 'on', 'off')
    const weekdaysOnly = choice(flags, 'weekdays-only', 'every-day')
    const times = atTimes(getOptionalStringFlag(flags, 'at'))
    const timezone = getOptionalStringFlag(flags, 'timezone')
    if (times || timezone || every === 'custom') {
      await assertCustomSchedules(client, botId)
    }
    const result = await callBots<{ change: string }>(client, 'bots.lookAround.set', {
      ...callerChat(),
      ...(botId ? { botId } : {}),
      ...(on !== undefined ? { on } : {}),
      ...(every ? { every } : {}),
      ...(weekdaysOnly !== undefined ? { weekdaysOnly } : {}),
      ...(times ? { times } : {}),
      // The first schedule edit saves this machine's zone when it is the host's.
      ...(times || every
        ? { editorTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
        : {}),
      // `host` goes back to the host's own clock.
      ...(timezone ? { timezone: timezone === 'host' ? null : timezone } : {}),
      // An empty --focus clears it.
      ...(typeof focus === 'string' ? { focus } : focus === true ? { focus: '' } : {})
    })
    printResult(result, json, (value) => value.change)
  },
  'bot look-around show': async ({ flags, client, json }) => {
    const selector = getOptionalStringFlag(flags, 'bot')
    const botId = selector ? (await findBot(client, selector)).id : undefined
    const result = await callBots<{ setting: BotLookAround; upNext: UpNextState }>(
      client,
      'bots.lookAround.get',
      { ...callerChat(), ...(botId ? { botId } : {}) }
    )
    printResult(result, json, lookAroundShowText)
  }
}
