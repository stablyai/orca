// Bringing a bot over from another app: the bots other apps keep on this host, and the plan and summary
// cards the new bot puts in its chat (`orca bot import plan|done`).
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { botImportDoneBody, botImportPlanBody } from '../../../../shared/bots/bot-import-cards'
import type { AgentJournalPlainStatusItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  BotImportDoneCard,
  BotImportPlanCard,
  BotImportSources
} from '../../../../shared/rpc-contract/bots-import-params'
import { findBotImportSources } from '../../../bots/bot-import-sources'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { LOOK_AROUND_REFUSAL } from '../../../bots/bot-look-around-policy'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, InvalidArgumentError } from '../core'

function callingBot(
  runtime: OrcaRuntimeService,
  callerSessionId: string,
  pairedDeviceId: string | undefined
) {
  runtime.bots.assertEnabled()
  // A session id names a chat only on its own host.
  const bot = pairedDeviceId === undefined ? botOfSession(runtime.bots, callerSessionId) : null
  if (!bot) {
    throw new InvalidArgumentError("Run this from a bot's chat.")
  }
  if (runtime.lookAround.botOfLook(callerSessionId)) {
    throw new InvalidArgumentError(LOOK_AROUND_REFUSAL)
  }
  return bot
}

async function writeCard(sessionId: string, body: AgentJournalPlainStatusItem, kind: string) {
  const host = getStructuredAgentSessionHost()
  // Null for a session this host doesn't run.
  const destination = await host?.captureAgentStartDestination(sessionId)
  if (!host || !destination) {
    throw new InvalidArgumentError('Run this from your chat in Orca.')
  }
  await host.appendAgentStart(
    destination,
    { body, messageId: `${kind}:${randomUUID()}` },
    Date.now()
  )
}

export const BOT_IMPORT_METHODS = [
  defineMethod({
    name: 'bots.import.sources',
    permission: 'workspace',
    params: BotImportSources,
    handler: async (_params, { runtime }) => {
      runtime.bots.assertEnabled()
      return {
        sources: await findBotImportSources(
          { home: homedir(), platform: process.platform, env: process.env },
          runtime.bots.list()
        )
      }
    }
  }),
  defineMethod({
    name: 'bots.import.plan',
    permission: 'workspace',
    params: BotImportPlanCard,
    handler: async ({ callerSessionId, plan }, { runtime, pairedDeviceId }) => {
      const bot = callingBot(runtime, callerSessionId, pairedDeviceId)
      await writeCard(
        callerSessionId,
        botImportPlanBody({ ...plan, botId: bot.id }),
        'bot-import-plan'
      )
      return {
        message:
          'Your owner now sees the plan as a card in this chat, with a checkbox on each item that comes over. End your turn and wait for their answer; write nothing until then.'
      }
    }
  }),
  defineMethod({
    name: 'bots.import.done',
    permission: 'workspace',
    params: BotImportDoneCard,
    handler: async ({ callerSessionId, done }, { runtime, pairedDeviceId }) => {
      const bot = callingBot(runtime, callerSessionId, pairedDeviceId)
      await writeCard(
        callerSessionId,
        botImportDoneBody({ ...done, botId: bot.id }),
        'bot-import-done'
      )
      return {
        message:
          'Your owner now sees the summary card. Next, offer what needs connecting, one card each, and say in one line to turn the schedules on once the old bot is off.'
      }
    }
  })
] as const
