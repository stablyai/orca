// An automation run's result as a note in its bot's Chat: the person sees it, the bot reads it later.

import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AutomationBotTarget } from '../../shared/automations/automation-definition'
import { hasAutomationSchedule } from '../../shared/automation-event-triggers'
import {
  automationResultNoteBody,
  automationResultNoteClientMessageId,
  makeAutomationResultNote,
  type AutomationResultNote
} from '../../shared/bots/bot-automation-result-note'
import { writeStructuredAgentSessionOrcaNote } from '../native-chat/agent-session-wire/structured-agent-session-orca-note'
import { requireStructuredHost, type runtimeBotChats } from './bot-chat-session'
import type { Bot } from '../../shared/bot-types'
import type { BotRunResult } from './bot-run-results'

export type BotRunNoteDependencies = {
  /** An Orca note in the bot's Chat: the agent reads it only with the person's next message. */
  noteToChat(bot: Bot, note: AutomationResultNote): Promise<unknown>
}

/** A run in its own conversation leaves a note in the Chat, unless the bot is to react to it. */
export function takesNote(
  target: Pick<AutomationBotTarget, 'runsIn' | 'resultsTo' | 'letBotReact'>
): boolean {
  return target.resultsTo === 'chat' && target.runsIn === 'new' && !target.letBotReact
}

/** Nothing for a target that takes no note. Writing can fail; the run still ended, so its history
 *  records only the miss. */
export async function leave(
  deps: BotRunNoteDependencies,
  result: BotRunResult,
  outcome: AutomationResultNote['outcome'],
  text: string
): Promise<{ error?: string }> {
  if (!takesNote(result.target)) {
    return {}
  }
  try {
    await deps.noteToChat(result.bot, botRunResultNote(result, outcome, text))
    return {}
  } catch (error) {
    console.warn('[bots] could not add a run result note to the Chat', error)
    return { error: "The result couldn't be added to the bot's Chat." }
  }
}

function botRunResultNote(
  { automation, bot, run, sessionId }: BotRunResult,
  outcome: AutomationResultNote['outcome'],
  result: string
): AutomationResultNote {
  return makeAutomationResultNote({
    automationId: automation.id,
    automationName: automation.name,
    botName: bot.name,
    runId: run.id,
    sessionId,
    trigger: hasAutomationSchedule(automation) ? 'schedule' : 'event',
    outcome,
    result,
    at: Date.now()
  })
}

export function runtimeNoteToChat(
  runtime: OrcaRuntimeService,
  chats: ReturnType<typeof runtimeBotChats>
): BotRunNoteDependencies['noteToChat'] {
  return async (bot, note) =>
    writeStructuredAgentSessionOrcaNote(
      await requireStructuredHost(runtime),
      await chats.ensure(bot.id),
      automationResultNoteClientMessageId(note.runId),
      automationResultNoteBody(note)
    )
}
