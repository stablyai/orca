import type { JournalMailObservation } from '../../../../native-chat/agent-session-journal/journal-mail-observation'
import type { StructuredMailSendRow } from '../../db/messages/structured-mail-send-store'
import type { MessageRow } from '../../db/orchestration-records'
import {
  orchestrationMailNotice,
  readAgentMessageSource
} from '../../../../../shared/agent-session/agent-session-message-source'

/** Compare the admitted fields, never a newly rendered address or reply line. */
export function structuredMailWasDeliveredWhole(
  attempt: StructuredMailSendRow,
  message: MessageRow,
  observation: JournalMailObservation
): boolean {
  const { body } = observation
  if (
    observation.state.kind !== 'accepted' ||
    !body ||
    body.kind !== 'message' ||
    message.id !== attempt.message_id
  ) {
    return false
  }
  const mail = orchestrationMailNotice(readAgentMessageSource(body.from))
  if (
    !mail ||
    mail.mailbox !== attempt.mailbox_handle ||
    !Array.isArray(body.blocks) ||
    body.blocks.length !== 1
  ) {
    return false
  }
  const block = body.blocks[0]
  if (block?.type !== 'text' || typeof block.text !== 'string') {
    return false
  }
  const matches = mail.messages.filter((member) => member.messageId === attempt.message_id)
  const member = matches.length === 1 ? matches[0] : undefined
  const content = member?.content
  if (
    !member ||
    !content ||
    member.runId !== message.run_id ||
    member.from !== message.from_handle
  ) {
    return false
  }
  let end = 0
  const equal = (
    range: readonly [number, number] | undefined,
    value: string | null,
    required = false
  ) => {
    if (!required && !value) {
      return range === undefined
    }
    if (!range || !Array.isArray(range) || range.length !== 2) {
      return false
    }
    const [start, stop] = range
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(stop) ||
      start < end ||
      stop < start ||
      stop > block.text.length
    ) {
      return false
    }
    end = stop
    return block.text.slice(start, stop) === value
  }
  return (
    equal(content.subject, message.subject, true) &&
    equal(content.body, message.body) &&
    equal(content.payload, message.payload)
  )
}
