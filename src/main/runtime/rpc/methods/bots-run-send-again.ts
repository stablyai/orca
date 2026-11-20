// `bots.sendRunAgain`: the owner's Send again on a run that couldn't start. Orca sends the text its
// card kept, with the same run, to the chat the card is in, once ever: the first attempt spends the run
// in the orchestration database before it sends, and any later one, from any client or after a
// restart, is refused.
import { BotRunSendAgainParams } from '../../../../shared/rpc-contract/bots-params'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalAutomationRunNotStartedItem } from '../../../../shared/agent-journal-orca-card-items'
import { readAutomationRunMessage } from '../../../../shared/automations/automation-run-message'
import { runKeyedSerializedOperation } from '../../../../shared/concurrency/keyed-serialized-operations'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import {
  requireStructuredHost,
  runtimeBotChats,
  type BotRunFields
} from '../../../bots/bot-chat-session'
import { chatThatTookIt } from '../../../bots/bot-automation-sessions'
import { automationRunMemoryLabel } from '../../../bots/bot-turn-source'
import { ownerOnly } from './bots-caller-gates'
import { defineMethod, InvalidArgumentError } from '../core'

type NotStarted = Omit<AgentJournalAutomationRunNotStartedItem, 'kind'>

export const RUN_ALREADY_SENT = 'This run was already sent again.'

/** The run's card in this chat, or 'sent' once a message there carries the run. */
export function runToSendAgain(
  bodies: readonly AgentJournalItemBody[],
  runId: string
): NotStarted | 'sent' | null {
  let card: NotStarted | null = null
  for (const body of bodies) {
    if (body.kind === 'message' && body.automationRun?.runId === runId) {
      return 'sent'
    }
    if (body.kind === 'automation-run-not-started' && body.run.runId === runId) {
      const run = readAutomationRunMessage(body.run)
      card =
        run && Array.isArray(body.actsFor)
          ? { run, actsFor: body.actsFor, error: body.error, text: body.text, at: body.at }
          : null
    }
  }
  return card
}

/** Every message the chat holds that mentions the run: its rows, sends not yet echoed, and its queued cards. */
async function runBodies(
  host: Pick<StructuredAgentSessionHost, 'conversation'>,
  sessionId: string,
  runId: string
): Promise<AgentJournalItemBody[]> {
  const { journal } = await host.conversation(sessionId)
  const { items, sent } = await journal.reads.runMentions(runId)
  return [
    ...items.map((item) => item.body),
    ...sent.map((item) => item.body),
    ...(await journal.queuedMessages.list()).map((row) => row.body)
  ]
}

export type RunSendAgainDependencies = {
  host: Pick<StructuredAgentSessionHost, 'conversation'>
  /** Spends the run's one Send again in one durable write; false once it was ever spent. */
  claim: (runId: string, sessionId: string) => boolean
  send: (text: string, run: BotRunFields) => Promise<{ sessionId: string }>
}

// One Send again per run at a time, so two clicks or two clients read and claim in turn.
const sending = new Map<string, Promise<void>>()

export function sendRunAgain(
  deps: RunSendAgainDependencies,
  input: { botId: string; sessionId: string; runId: string }
): Promise<{ sessionId: string }> {
  return runKeyedSerializedOperation(sending, input.runId, async () => {
    const found = runToSendAgain(
      await runBodies(deps.host, input.sessionId, input.runId),
      input.runId
    )
    if (found === 'sent') {
      throw new InvalidArgumentError(RUN_ALREADY_SENT)
    }
    if (!found || found.run.automation.bot?.botId !== input.botId) {
      throw new InvalidArgumentError('run_not_found')
    }
    // The durable claim is what makes it once, ever: the journal reads above can miss a copy that
    // moves from the queue to the transcript between them.
    if (!deps.claim(input.runId, input.sessionId)) {
      throw new InvalidArgumentError(RUN_ALREADY_SENT)
    }
    const { run, text } = found
    return deps.send(text, {
      memorySource: automationRunMemoryLabel(run.automation.name, run.event),
      automationRun: run
    })
  })
}

export const BOT_RUN_SEND_AGAIN_METHOD = defineMethod({
  name: 'bots.sendRunAgain',
  permission: 'workspace',
  params: BotRunSendAgainParams,
  handler: async ({ botId, sessionId, runId }, context) => {
    const { runtime } = context
    runtime.bots.assertEnabled()
    ownerOnly(context, 'Only your owner sends a run again, in Orca.')
    const bot = runtime.bots.list().find((entry) => entry.id === botId)
    if (!bot) {
      throw new InvalidArgumentError('bot_not_found')
    }
    const chats = runtimeBotChats(runtime)
    return sendRunAgain(
      {
        host: await requireStructuredHost(runtime),
        claim: (id, chat) => runtime.getOrchestrationDb().claimBotRunResend(id, chat),
        send: async (text, run) => {
          try {
            return {
              sessionId: chatThatTookIt(await chats.sendToSession(bot.id, sessionId, text, run))
                .sessionId
            }
          } catch (error) {
            throw new InvalidArgumentError(error instanceof Error ? error.message : String(error))
          }
        }
      },
      { botId, sessionId, runId }
    )
  }
})
