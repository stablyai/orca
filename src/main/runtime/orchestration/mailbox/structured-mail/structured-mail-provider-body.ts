import {
  orchestrationMailNotice,
  readAgentMessageSource
} from '../../../../../shared/agent-session/journal/agent-session-message-source'
import type { AgentJournalMessageItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  localOrchestrationCliCommand,
  type OrchestrationCliCommand
} from '../../workers/launch/orchestration-cli-command'
import { formatMessagePointer } from '../formatting/message-formatting'

/** What the agent itself is sent for a mail card: Orca's pointer at `check`, never another agent's
 *  words. Mail read through `check` reaches the agent as tool output, which no reviewer counts as the
 *  user's authorization; a person's own messages pass through unchanged. */
export function structuredMailProviderBody(
  body: AgentJournalMessageItem,
  cliCommand: OrchestrationCliCommand = localOrchestrationCliCommand()
): AgentJournalMessageItem {
  const mail = orchestrationMailNotice(readAgentMessageSource(body.from))
  if (!mail) {
    return body
  }
  const pointer = formatMessagePointer(
    Math.max(1, mail.messages.length),
    mail.mailbox,
    cliCommand
  ).trim()
  return { ...body, blocks: [{ type: 'text', text: pointer }] }
}
