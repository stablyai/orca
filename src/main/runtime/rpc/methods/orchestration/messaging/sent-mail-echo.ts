// A chat's own record of the inter-agent mail it sent: a display-only line, never provider context.
import type { MessageRow } from '../../../../orchestration/db/orchestration-records'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { writeInChat } from '../../../../../bots/bot-chat-status-line'
import { parseOrcaSessionAddress } from '../../../../../../shared/agent-session/identity/orca-session-address'

/** The mail a chat shows as sent: an agent asking or handing off to another. Lifecycle mail,
 *  reports, and mail a bot request already cards keep their existing rows. */
const CHAT_SENT_MAIL_TYPES: ReadonlySet<string> = new Set(['question', 'handoff'])

const SUBJECT_MAX_LENGTH = 300
const BODY_EXCERPT_MAX_LENGTH = 200

/** Note in its chat what a send from an Orca session just sent, under an id a retry writes once.
 *  A worker handle's send has no chat here, and a failed note is logged, never thrown. */
export function noteSentMailInChat(
  runtime: Pick<OrcaRuntimeService, 'orchestrationSenderNames'>,
  message: Pick<MessageRow, 'id' | 'from_handle' | 'to_handle' | 'subject' | 'body' | 'type'>
): void {
  try {
    if (!CHAT_SENT_MAIL_TYPES.has(message.type)) {
      return
    }
    const sessionId = parseOrcaSessionAddress(message.from_handle)
    if (!sessionId) {
      return
    }
    writeInChat(
      sessionId,
      {
        kind: 'status',
        text: sentMailLine(recipientName(runtime, message.to_handle), message.subject, message.body)
      },
      'mail-sent',
      {
        messageId: `mail-sent:${message.id}`,
        failureLog: '[orchestration] sent mail note failed'
      }
    )
  } catch (error) {
    console.warn('[orchestration] sent mail note failed', error)
  }
}

/** `Sent to <name>: <subject> — <body head>`, one compact line in the sending chat. */
function sentMailLine(toName: string, subject: string, body: string | null | undefined): string {
  const line = `Sent to ${toName}: ${oneLine(subject, SUBJECT_MAX_LENGTH) || '(no subject)'}`
  const excerpt = oneLine(body ?? '', BODY_EXCERPT_MAX_LENGTH)
  return excerpt ? `${line} — ${excerpt}` : line
}

/** What the recipient is called now; a name that can't be read leaves its address standing. */
function recipientName(
  runtime: Pick<OrcaRuntimeService, 'orchestrationSenderNames'>,
  address: string
): string {
  try {
    return runtime.orchestrationSenderNames.sender(address).name ?? address
  } catch {
    return address
  }
}

/** A subject or body as one bounded line, so a sent row stays compact however long the mail is. */
function oneLine(text: string, maxLength: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1).trimEnd()}…` : flat
}
