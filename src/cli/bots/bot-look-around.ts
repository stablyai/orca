import type { CommandHandler } from '../dispatch/dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { callerChat } from '../automations/automation-caller-chat'
import { callBots, findBot } from './bot'

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
    const result = await callBots<{ change: string }>(client, 'bots.lookAround.set', {
      ...callerChat(),
      ...(botId ? { botId } : {}),
      ...(on !== undefined ? { on } : {}),
      ...(every ? { every } : {}),
      ...(weekdaysOnly !== undefined ? { weekdaysOnly } : {}),
      // An empty --focus clears it.
      ...(typeof focus === 'string' ? { focus } : focus === true ? { focus: '' } : {})
    })
    printResult(result, json, (value) => value.change)
  }
}
