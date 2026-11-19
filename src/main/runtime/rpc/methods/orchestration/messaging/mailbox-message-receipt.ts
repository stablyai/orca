import type { MessageRow } from '../../../../orchestration/db/orchestration-records'
import type { MailboxDeliveryBatch } from '../../../../orchestration/db/messages/role-mailbox-delivery'
import { formatMessageBanner } from '../../../../orchestration/mailbox/formatting/message-formatting'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationSessionCaller } from '../../../../orchestration/addressing/orchestration-caller-identity'
import { getMessagesByIds } from '../../../../orchestration/db/messages/messages-by-id'
import { replyFollowUp } from './reply-follow-up'
import { botItemOfReport } from '../../../../../bots/bot-item-report-fact'
import type { BotItemReportFact } from '../../../../../../shared/bots/bot-item-report-hint'
import type { ReportFollowUpAction } from '../../../../../../shared/orchestration/mailbox/orchestration-report-follow-up'

// Hide read/sequence, pointer_* and sender_pane_key: they are runtime delivery plumbing, not caller mailbox truth.
const INTERNAL_MESSAGE_COLUMNS = [
  'answer_sender_snapshot',
  'read',
  'sequence',
  'sender_pane_key',
  'pointer_enter_pending',
  'pointer_pty_id',
  'pointer_process_incarnation'
] as const

export type MailboxMessageReceipt = Omit<MessageRow, (typeof INTERNAL_MESSAGE_COLUMNS)[number]>

export function exposeMessage(message: MessageRow): MailboxMessageReceipt {
  return exposeMessages([message])[0]!
}

export function exposeMessages(messages: MessageRow[]): MailboxMessageReceipt[] {
  return messages.map((message) => {
    const exposed: Partial<MessageRow> = { ...message }
    for (const column of INTERNAL_MESSAGE_COLUMNS) {
      delete exposed[column]
    }
    return exposed as MailboxMessageReceipt
  })
}

/** The one shape a consuming check returns, and the receipt its take commits. */
export function deliveryReceipt(args: {
  mailbox: { runId: string; dispatchId?: string }
  batch: MailboxDeliveryBatch | undefined
  acknowledged: string | undefined
  format: boolean
}) {
  const { batch } = args
  if (batch?.finalResponse) {
    const saved = batch.finalResponse
    const response = {
      ...saved,
      replayed: batch.replayed,
      acknowledged: args.acknowledged ?? null
    }
    if (args.format) {
      response.formatted = batch.messages
        .map((message, index) =>
          formatMessageBanner(message, {
            followUp: saved.messages[index]?.follow_up
          })
        )
        .join('\n\n')
    } else {
      delete response.formatted
    }
    return response
  }
  return {
    ...args.mailbox,
    deliveryId: batch?.delivery.id ?? null,
    messages: exposeMessages(batch?.messages ?? []),
    count: batch?.messages.length ?? 0,
    replayed: batch?.replayed ?? false,
    ...(batch ? { deliveryAcknowledged: true } : {}),
    acknowledged: args.acknowledged ?? null,
    timedOut: false,
    cancelled: false,
    connectionLost: false,
    ...(args.format
      ? { formatted: batch?.messages.map(formatMessageBanner).join('\n\n') ?? '' }
      : {})
  }
}

/** --ack without --wait only acknowledges: newer mail stays unread, so its wake still fires. */
export function acknowledgedOnlyReceipt(
  mailbox: { runId: string; dispatchId?: string },
  deliveryId: string
) {
  return {
    ...deliveryReceipt({ mailbox, batch: undefined, acknowledged: deliveryId, format: false }),
    next: 'A plain check already acknowledges the mail it shows, so --ack is not needed. Run check without --ack to read new mail.'
  }
}

// A check ends the moment it hands over a batch: that batch's receipt is already final.
export function handsOverBatch(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'deliveryAcknowledged' in result &&
    result.deliveryAcknowledged === true
  )
}

/** Adds what each message offers instead of `[Reply:]` for this reader, so every check view prints the same. */
export function withReplyFollowUps<T>(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  reader: OrchestrationSessionCaller | undefined,
  result: T
): T {
  if (typeof result !== 'object' || result === null || !('messages' in result)) {
    return result
  }
  const { messages } = result
  if (!Array.isArray(messages) || messages.length === 0) {
    return result
  }
  const formatted = 'formatted' in result && typeof result.formatted === 'string'
  let changed = false
  const lineageCache = new Map()
  const party = reader ? { party: reader, sessionId: reader.sessionId } : undefined
  const stored = getMessagesByIds(
    db,
    messages.map((message: MailboxMessageReceipt) => message.id)
  )
  const rows = messages.map((message: MailboxMessageReceipt) => {
    const row = stored.get(message.id)
    const followUp = row ? replyFollowUp(runtime, db, row, party, lineageCache) : undefined
    changed ||= followUp !== undefined
    return { message, row, followUp }
  })
  if (!changed) {
    return result
  }
  return {
    ...result,
    messages: rows.map(({ message, followUp }) =>
      followUp ? { ...message, follow_up: followUp } : message
    ),
    ...(formatted
      ? {
          formatted: rows
            .flatMap(({ row, followUp }) => (row ? [formatMessageBanner(row, { followUp })] : []))
            .join('\n\n')
        }
      : {})
  }
}

type ReportReceipt = MailboxMessageReceipt & { follow_up?: ReportFollowUpAction }

/** Names the open item each finished worker's report was started for, read now. A failed read leaves
 *  that report as it was. */
export async function withReportItems<T>(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  result: T
): Promise<T> {
  if (typeof result !== 'object' || result === null || !('messages' in result)) {
    return result
  }
  const { messages } = result
  if (!Array.isArray(messages)) {
    return result
  }
  const reports = messages.filter((message: ReportReceipt) => message.type === 'worker_done')
  if (reports.length === 0) {
    return result
  }
  const rows = getMessagesByIds(
    db,
    messages.map((message: ReportReceipt) => message.id)
  )
  const items = new Map<string, BotItemReportFact>()
  const readItem = botItemOfReport(runtime.botItems)
  await Promise.all(
    reports.map(async (message: ReportReceipt) => {
      const row = rows.get(message.id)
      const item = row ? await readItem(db, row).catch(() => null) : null
      if (item) {
        items.set(message.id, item)
      }
    })
  )
  if (items.size === 0) {
    return result
  }
  const formatted = 'formatted' in result && typeof result.formatted === 'string'
  return {
    ...result,
    messages: messages.map((message: ReportReceipt) => {
      const item = items.get(message.id)
      return item ? { ...message, for_item: item } : message
    }),
    ...(formatted
      ? {
          formatted: messages
            .flatMap((message: ReportReceipt) => {
              const row = rows.get(message.id)
              return row
                ? [
                    formatMessageBanner(row, {
                      followUp: message.follow_up,
                      reportItem: items.get(message.id)
                    })
                  ]
                : []
            })
            .join('\n\n')
        }
      : {})
  }
}

/** The mailboxes a consuming check took mail from: its messages' own, and the one an acknowledgement
 *  settled. Only their waiting cards can have gone stale. */
export function checkedMailboxes(result: unknown): string[] {
  if (typeof result !== 'object' || result === null) {
    return []
  }
  const mailboxes = new Set<string>()
  if ('messages' in result && Array.isArray(result.messages)) {
    for (const message of result.messages) {
      if (
        typeof message === 'object' &&
        message !== null &&
        typeof message.to_handle === 'string'
      ) {
        mailboxes.add(message.to_handle)
      }
    }
  }
  if ('acknowledged' in result && typeof result.acknowledged === 'string') {
    if ('dispatchId' in result && typeof result.dispatchId === 'string') {
      mailboxes.add(`dispatch:${result.dispatchId}`)
    } else if ('runId' in result && typeof result.runId === 'string') {
      mailboxes.add(`run:${result.runId}`)
    }
  }
  return [...mailboxes]
}
