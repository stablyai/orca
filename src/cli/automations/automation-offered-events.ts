// Which of a source's events this bot's Orca Cloud sends: GitHub's newer events, and finished workflow
// runs, only where it lists them.
import { GITHUB2_EVENT_KINDS, WORKFLOW_EVENT_KINDS } from '../../shared/automation-github-triggers'
import {
  AUTOMATION_EVENT_KINDS,
  type AutomationEventSource
} from '../../shared/automation-event-triggers'
import type { BotConnectors } from '../../shared/bot-event-sources'

/** A source's events this bot's Orca Cloud sends: GitHub's newer ones only where it lists them. */
export function offeredEvents(
  source: AutomationEventSource,
  bot?: BotConnectors
): readonly string[] {
  const kinds: readonly string[] = AUTOMATION_EVENT_KINDS[source]
  if (source !== 'github' || !bot) {
    return kinds
  }
  return kinds.filter(
    (event) =>
      (bot.githubEvents2 === true || !GITHUB2_EVENT_KINDS.includes(event)) &&
      (bot.githubWorkflows === true || !WORKFLOW_EVENT_KINDS.includes(event))
  )
}
