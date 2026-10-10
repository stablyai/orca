import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type Database from '../../sqlite/sync-database'
import { readAgentSessionRefusalReference } from '../../../shared/agent-session-wire-refusals'

export const commandReceiptScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({ kind: z.literal('caller'), callerKey: z.string().min(1) })
])

export type CommandReceiptScope = z.infer<typeof commandReceiptScopeSchema>

/** Sends look across callers; other methods look up only the authenticated caller's row. */
export function commandReceiptScope(
  callerKey: string,
  operationIdScope?: 'global'
): CommandReceiptScope {
  return operationIdScope === 'global' ? { kind: 'global' } : { kind: 'caller', callerKey }
}

/** The pointer locates the result; if its row is gone, the command stays spent: read what remains, else unknown, never rerun. */
export const commandReceiptResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('journal-row'),
    epoch: z.string().min(1),
    sequence: z.int().positive()
  }),
  z.strictObject({
    kind: z.literal('queued-draft'),
    messageId: z.string().min(1)
  }),
  z.strictObject({
    kind: z.literal('no-op'),
    outcome: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('cancel'),
        cancelled: z.literal(false),
        turnId: z.string().optional()
      }),
      z.strictObject({ kind: z.literal('queue-resume'), resumed: z.literal(false) })
    ])
  })
])

export type CommandReceiptResult = z.infer<typeof commandReceiptResultSchema>

const rejectionSchema = z
  .strictObject({ reference: z.unknown(), message: z.string().optional() })
  .transform((value, ctx) => {
    const reference = readAgentSessionRefusalReference(value.reference)
    if (!reference || !isDeepStrictEqual(reference, value.reference)) {
      ctx.addIssue({ code: 'custom', message: 'unreadable command refusal' })
      return z.NEVER
    }
    return { reference, ...(value.message !== undefined ? { message: value.message } : {}) }
  })

const receiptIdentity = {
  operationId: z.string().min(1),
  sessionId: z.string().min(1),
  callerKey: z.string().min(1),
  method: z.string().min(1),
  fingerprint: z.string().min(1),
  acceptedAt: z.int().nonnegative()
}

export const commandReceiptSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...receiptIdentity,
    status: z.literal('accepted'),
    result: commandReceiptResultSchema
  }),
  z.strictObject({
    ...receiptIdentity,
    status: z.literal('rejected'),
    rejection: rejectionSchema
  })
])

export type CommandReceipt = z.infer<typeof commandReceiptSchema>

/** Additive, so no version bump: one would stop older builds writing this database. */
export function ensureCommandReceiptsTable(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS agent_session_command_receipts (
  operation_id  TEXT    NOT NULL,
  session_id    TEXT    NOT NULL REFERENCES agent_session_records(session_id) ON DELETE CASCADE,
  caller_key    TEXT    NOT NULL,
  method        TEXT    NOT NULL,
  fingerprint   TEXT    NOT NULL,
  status        TEXT    NOT NULL,
  result_json   TEXT,
  rejection_json TEXT,
  accepted_at   INTEGER NOT NULL,
  PRIMARY KEY (operation_id, caller_key)
);
CREATE INDEX IF NOT EXISTS agent_session_command_receipts_session
  ON agent_session_command_receipts (session_id);
`)
}
