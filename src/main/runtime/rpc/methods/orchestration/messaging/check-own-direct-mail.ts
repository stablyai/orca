// Mail sent to a coordinator's own address outside its Runs (bot item mail, run_unbound) has no Run
// Delivery; a plain check returns it with the Run's mail, as the pointer it was woken by names no Run.
import type { MessageRow, MessageType } from '../../../../orchestration/db/orchestration-records'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationSessionCaller } from '../../../../orchestration/addressing/orchestration-caller-identity'
import { formatMessageBanner } from '../../../../orchestration/mailbox/formatting/message-formatting'
import type { CheckMailReconciliation } from './check-mail-reconciliation'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../../../shared/orchestration/orchestration-rpc-contract'
import {
  exposeMessages,
  withReplyFollowUps,
  type MailboxMessageReceipt
} from './mailbox-message-receipt'

type Answer = {
  messages?: MailboxMessageReceipt[]
  count?: number
  formatted?: string
  next?: string
}

/** The caller's unread direct mail that no Run owns, outside `runId`. */
export function ownDirectMail(
  db: OrchestrationDb,
  handle: string,
  runId: string,
  typeFilter: MessageType[] | undefined
): MessageRow[] {
  return (
    db
      .getUnreadMessages(handle, typeFilter, { excludeRunOwnedDirect: true })
      // Legacy mail is inspect-only, as a direct check treats it.
      .filter(
        (message) => message.run_id !== runId && message.run_id !== ORCHESTRATION_LEGACY_RUN_ID
      )
  )
}

/** Takes the caller's own direct mail and adds it to the Run check's answer, in sequence order. */
export async function withOwnDirectMail(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  reader: OrchestrationSessionCaller | undefined
  handle: string
  runId: string
  typeFilter: MessageType[] | undefined
  format: boolean
  reconciliation: CheckMailReconciliation
  revalidate: () => void
  record: ((receipt: unknown) => void) | undefined
  result: unknown
}): Promise<unknown> {
  const { db } = args
  const selected = ownDirectMail(db, args.handle, args.runId, args.typeFilter)
  const run = args.result
  if (selected.length === 0 || !isAnswer(run)) {
    return run
  }
  return args.reconciliation.takeDirect({
    selected,
    revalidate: args.revalidate,
    record: args.record,
    respond: (taken) => {
      const sequence = new Map(
        [...taken, ...(run.messages ?? []).map((m) => db.getMessageById(m.id))]
          .filter((row): row is MessageRow => !!row)
          .map((row) => [row.id, row.sequence])
      )
      const messages = [...(run.messages ?? []), ...exposeMessages(taken)].sort(
        (a, b) => (sequence.get(a.id) ?? 0) - (sequence.get(b.id) ?? 0)
      )
      const { next, ...rest } = run
      // Follow-ups and the formatted view are rebuilt over the whole answer, in its order.
      return withReplyFollowUps(args.runtime, db, args.reader, {
        ...rest,
        // "Wait for reports" is wrong once this answer carries mail.
        ...(next && (run.count ?? 0) > 0 ? { next } : {}),
        messages,
        count: messages.length,
        ...(args.format ? { formatted: messages.map((m) => formatOne(db, m)).join('\n\n') } : {})
      })
    }
  })
}

function formatOne(db: OrchestrationDb, message: MailboxMessageReceipt): string {
  const row = db.getMessageById(message.id)
  return row ? formatMessageBanner(row) : ''
}

function isAnswer(value: unknown): value is Answer {
  return (
    typeof value === 'object' &&
    value !== null &&
    (!('messages' in value) || Array.isArray(value.messages))
  )
}
