import type { Automation } from '../../shared/automations/automation-definition'
import { orcaCloudNeedsSignIn } from '../../shared/bots/host-orca-sign-in'
import type { BotRunResults } from '../automations/bot-automation-launch'
import { writeStructuredAgentSessionOrcaNote } from '../native-chat/agent-session-wire/structured-agent-session-orca-note'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { chatThatTookIt } from './bot-automation-sessions'
import { requireStructuredHost, runtimeBotChats } from './bot-chat-session'
import {
  alertBotCouldNotStart,
  botRunRefusalAlerts,
  runtimeBotOwnerNotice
} from './bot-could-not-finish'
import { runtimeBotRunNotStarted, showBotRunNotStarted } from './bot-run-not-started'
import { runtimeNoteToChat } from './bot-run-result-note'
import { deliverBotRunResult } from './bot-run-results'
import { keepSlackRunAnswer } from './bot-slack-answer-guidance'
import {
  CONNECTOR_SLACK_PRESENTATION_FEATURE,
  CONNECTOR_SLACK_PRESENTATION_TURN_END_FEATURE
} from '../../shared/connectors/slack-answer-presentation'
import { watchBotTurnEnds } from './bot-run-turn-watch'
import { botTurnFor } from './bot-turn-for'
import { orcaSignInServer } from './orca-sign-in-server'

export function runtimeBotRunRefusals(
  runtime: OrcaRuntimeService
): (automation: Pick<Automation, 'name' | 'bot'>, error: string) => void {
  return botRunRefusalAlerts(runtimeBotOwnerNotice(runtime), () => runtime.bots.list())
}

export function runtimeBotRunResults(runtime: OrcaRuntimeService): BotRunResults {
  const chats = runtimeBotChats(runtime)
  return {
    watch: async (slackRunId, linkedThread) => {
      const host = await requireStructuredHost(runtime)
      const features = runtime.getConnectorCloud()?.cloudFeatures()
      if (
        !slackRunId ||
        !features?.has(CONNECTOR_SLACK_PRESENTATION_FEATURE) ||
        (linkedThread && !features.has(CONNECTOR_SLACK_PRESENTATION_TURN_END_FEATURE))
      ) {
        return watchBotTurnEnds(host)
      }
      const watched = watchBotTurnEnds(host, !linkedThread)
      let releaseSlot: (() => void) | null = null
      const release = keepSlackRunAnswer(
        slackRunId,
        linkedThread
          ? () =>
              Boolean(
                (releaseSlot ??=
                  runtime.getConnectorCloud()?.reservePreparedSlackTurnEnd(slackRunId) ?? null)
              )
          : undefined
      )
      return {
        dispose: () => {
          release()
          releaseSlot?.()
          watched.dispose()
        },
        next: async (send) => {
          try {
            const ended = await watched.next(send)
            if ('unavailable' in ended || ended.outcome !== 'success') {
              releaseSlot?.()
            }
            return ended
          } catch (error) {
            releaseSlot?.()
            throw error
          } finally {
            release()
          }
        }
      }
    },
    couldNotStart: (bot, automation, notStarted) => {
      alertBotCouldNotStart(runtimeBotOwnerNotice(runtime), bot, automation)
      if (notStarted) {
        void showBotRunNotStarted(
          runtimeBotRunNotStarted(runtime, chats),
          bot,
          notStarted.destination,
          notStarted.card
        )
      }
    },
    deliver: (result) =>
      deliverBotRunResult(
        {
          sendToChat: async (bot, text, from) =>
            chatThatTookIt(await chats.sendToChat(bot.id, text, from)),
          noteToChat: runtimeNoteToChat(runtime, chats),
          postAsBot: (bot, body) => runtime.getConnectorCloud()?.postAsBot(bot.id, body) ?? null,
          cloudSignedOut: () => orcaCloudNeedsSignIn(runtime.getConnectorCloud()?.status()),
          signInServer: () => orcaSignInServer(runtime),
          noteToRun: async (sessionId, noteId, text) =>
            writeStructuredAgentSessionOrcaNote(
              await requireStructuredHost(runtime),
              sessionId,
              noteId,
              { kind: 'status', text }
            ),
          replyInThread: (conversation, replyId, text, turnFor, presentation) =>
            runtime.getConnectorCloud()?.reply({
              replyId,
              conversation,
              turnId: Date.now(),
              text,
              turnFor,
              ...(presentation ? { presentation } : {})
            }) ?? null,
          // The host delivers the run's own result: no request to verify.
          turnForOf: (sessionId) => botTurnFor(runtime, sessionId, 'host'),
          ...runtimeBotOwnerNotice(runtime)
        },
        result
      )
  }
}
