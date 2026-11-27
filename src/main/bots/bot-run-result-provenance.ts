// A bot automation's result posted away from the thread the automation was made in says where it
// came from, so a reader of the channel or issue sees why it is there.
import type { Automation } from '../../shared/automations/automation-definition'
import type { BotRunResults } from '../automations/bot-automation-launch'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { botTurnFor } from './bot-turn-for'
import { originThreadText } from '../../shared/automations/automation-results-place'

/** The line a post opens with: the thread it was made in when the post lands elsewhere, "this
 *  thread" when the post is a reply there. */
export function withProvenance(
  message: string,
  automation: Pick<Automation, 'name' | 'bot'>,
  inOriginThread = false
): string {
  const origin = automation.bot?.originThread
  if (!origin) {
    return message
  }
  const where = inOriginThread ? 'this thread' : originThreadText(origin)
  return `_From the automation “${automation.name}”, created in ${where}._\n\n${message}`
}

/** What a run that answers in its own chat posts in the thread as it starts. */
export function originThreadStartLine(automation: Pick<Automation, 'name'>): string {
  return `_Running the automation “${automation.name}”, created in this thread._`
}

/** Posts a run's start line through its thread's conversation, as the bot; a failure only warns. */
export function runtimeRunStartLine(runtime: OrcaRuntimeService): BotRunResults['announce'] {
  return (conversation, replyId, text, send) => {
    void (async () => {
      const turnFor = await botTurnFor(runtime, send.sessionId, 'host')
      await runtime
        .getConnectorCloud()
        ?.reply({ replyId, conversation, turnId: Date.now(), text, turnFor })
    })().catch((error: unknown) =>
      console.warn('[bots] could not post a run’s start line in its thread', error)
    )
  }
}
