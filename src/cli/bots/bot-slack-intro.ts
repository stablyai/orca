import type { CommandHandler } from '../dispatch/dispatch'
import { getOptionalStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { callerChat } from '../automations/automation-caller-chat'
import { readInjectedBotToken } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { callBots, findBot } from './bot'

type IntroAnswer = {
  bot: { id: string; name: string }
  slackChannelHello: boolean
  cloud: 'yes' | 'no' | 'not_connected'
  /** Whether Orca Cloud acts on the saved setting now. */
  applied: boolean
  change: string
}

export const BOT_SLACK_INTRO_HANDLERS: Record<string, CommandHandler> = {
  'bot slack intro': async ({ flags, client, json }) => {
    if (flags.get('on') === true) {
      throw new RuntimeClientError(
        'invalid_argument',
        'This command can only turn the Slack intro off. Turn it back on in Orca, in the bot’s Slack settings.'
      )
    }
    const selector = getOptionalStringFlag(flags, 'bot')
    const botId = selector ? (await findBot(client, selector)).id : undefined
    const botToken = readInjectedBotToken()
    let answer: Awaited<ReturnType<typeof callBots<IntroAnswer>>>
    try {
      answer = await callBots<IntroAnswer>(client, 'bots.slackChannelHello.set', {
        ...callerChat(),
        ...(botToken ? { botToken } : {}),
        ...(botId ? { botId } : {}),
        ...(flags.get('off') === true ? { off: true } : {})
      })
    } catch (error) {
      if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'This bot’s Orca can’t change the Slack intro yet. Update Orca on the computer it runs on.'
        )
      }
      throw error
    }
    printResult(answer, json, (value) => value.change)
  }
}
