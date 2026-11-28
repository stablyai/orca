import type { CommandHandler } from '../dispatch/dispatch'
import {
  getOptionalStringFlag,
  getPresentStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { callerChat } from '../automations/automation-caller-chat'
import { callBots, findBot } from './bot'
import { LookAroundAgentSetupSchema, lookAroundSupported } from '../../shared/bots/bot-look-around'
import { sameBotAgentSetup } from '../../shared/bots/bot-agent-setup'
import type { Bot } from '../../shared/bot-types'

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
    const agent = getPresentStringFlag(flags, 'agent')
    const model = getPresentStringFlag(flags, 'model')
    const effort = getPresentStringFlag(flags, 'effort')
    if ((model || effort) && (!agent || agent === 'bot')) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Use --agent claude|codex with --model or --effort; --agent bot restores the bot’s setup.'
      )
    }
    if (agent && agent !== 'bot' && !lookAroundSupported(agent)) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Look around needs Claude Code or Codex; use --agent claude, codex, or bot.'
      )
    }
    const launch =
      model || effort
        ? {
            ...(model ? { model } : {}),
            ...(effort ? { options: { effort } } : {})
          }
        : undefined
    const setup =
      agent && agent !== 'bot'
        ? LookAroundAgentSetupSchema.safeParse({
            agent,
            ...(launch ? { launch } : {})
          })
        : undefined
    if (setup && !setup.success) {
      throw new RuntimeClientError(
        'invalid_argument',
        setup.error.issues[0]?.message ?? 'Invalid Look around launch choice.'
      )
    }
    const result = await callBots<{ change: string; bot: Bot }>(client, 'bots.lookAround.set', {
      ...callerChat(),
      ...(botId ? { botId } : {}),
      ...(agent === 'bot'
        ? { agentSetup: null }
        : setup?.success
          ? { agentSetup: setup.data }
          : {}),
      ...(on !== undefined ? { on } : {}),
      ...(every ? { every } : {}),
      ...(weekdaysOnly !== undefined ? { weekdaysOnly } : {}),
      // An empty --focus clears it.
      ...(typeof focus === 'string' ? { focus } : focus === true ? { focus: '' } : {})
    })
    if (
      agent &&
      !sameBotAgentSetup(
        setup?.success ? setup.data : undefined,
        result.result.bot.lookAround?.agentSetup
      )
    ) {
      throw new RuntimeClientError(
        'unsupported',
        'This Orca host did not save the Look around setup. Update Orca on that host.'
      )
    }
    printResult(result, json, (value) => value.change)
  }
}
