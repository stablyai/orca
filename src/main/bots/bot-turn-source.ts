// Labels a bot's automation runs carry, and which of its home files a turn's edits wrote.

import { basename } from 'node:path'
import type { AgentJournalItemBody } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AutomationRunEvent } from '../../shared/automation-event-triggers'
import {
  cleanBotMemoryLabel as clean,
  withBotMemoryLink as withLink
} from '../../shared/bots/bot-memory-source'
import { AUTOMATION_EVENT_SOURCE_NAMES } from '../automations/automation-event-prompt'
import { editFilesFromToolPair } from '../../shared/native-chat/tools/native-chat-edit-normalize'

/** An automation run's label, as its message carries it: the event that started it, else itself. */
export function automationRunMemoryLabel(
  automationName: string,
  event?: Pick<AutomationRunEvent, 'source' | 'place' | 'actor' | 'url'>
): string {
  if (!event) {
    return clean(`Automation ${automationName}`)
  }
  const where = `${AUTOMATION_EVENT_SOURCE_NAMES[event.source]}${event.place ? ` ${event.place}` : ''}`
  return withLink(clean(event.actor ? `${where}, ${event.actor}` : where), event.url)
}

/** Files a landed edit changed; reads, commands and failed edits change none. */
function editedPaths(body: AgentJournalItemBody): string[] {
  if (body.kind === 'diff') {
    return body.paths ?? [body.path]
  }
  if (body.kind !== 'tool-call') {
    return []
  }
  const files = editFilesFromToolPair({
    name: body.name,
    input: body.input,
    state: body.state,
    ...(body.output ? { result: { output: body.output.head } } : {})
  })
  return (files ?? []).flatMap((file) => (file.oldPath ? [file.path, file.oldPath] : [file.path]))
}

/** Whether an edit in the bot's own turn changed this home file. */
export function writesHomeFile(body: AgentJournalItemBody, name: 'SOUL.md' | 'MEMORY.md'): boolean {
  return editedPaths(body).some((path) => basename(path) === name)
}
