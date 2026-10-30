import { createHash } from 'node:crypto'
import { commandReceiptSchema } from '../../native-chat/agent-session-journal/command-receipt-schema'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import { ordinaryMailCreationId } from './structured-mail-creation-contract'

export type MailCreationOperation = {
  operationId: string
  state: 'accepted' | 'absent' | 'unknown'
  evidence: string
}
export const MAIL_CALLER = 'trusted-local:orchestration:ordinary-mail'
const stableValue = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') {
    return [typeof value, value ?? null]
  }
  if (Array.isArray(value)) {
    return value.map(stableValue)
  }
  return Object.keys(value)
    .sort()
    .map((key) => [key, stableValue(Reflect.get(value, key))])
}
const digest = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')

/** Only readable retained blockers advance this private family; storage and live ownership never do. */
export function selectMailCreationOperation(
  host: StructuredAgentSessionHost,
  source: { run_id: string; id: string }
): MailCreationOperation {
  let operationId = ordinaryMailCreationId(source)
  const blockers: string[] = []
  for (;;) {
    const rows = host.deps.journalDatabase.db
      .prepare(`SELECT caller_key, session_id, method, fingerprint, status, result_json,
        rejection_json, accepted_at FROM agent_session_command_receipts
        WHERE operation_id = ? ORDER BY caller_key`)
      .all(operationId)
    const operation = host.deps.store.getGlobalOperationRow(operationId)
    const evidence = digest([blockers, rows, operation])
    for (const row of rows) {
      if (
        (row.status === 'accepted' && row.rejection_json !== null) ||
        (row.status === 'rejected' && row.result_json !== null)
      ) {
        continue
      }
      let parsed
      try {
        parsed = commandReceiptSchema.safeParse({
          operationId,
          sessionId: row.session_id,
          callerKey: row.caller_key,
          method: row.method,
          fingerprint: row.fingerprint,
          status: row.status,
          acceptedAt: row.accepted_at,
          ...(row.status === 'accepted'
            ? { result: JSON.parse(String(row.result_json)) }
            : { rejection: JSON.parse(String(row.rejection_json)) })
        })
      } catch {
        continue
      }
      if (!parsed.success) {
        continue
      }
      const receipt = parsed.data
      if (receipt.callerKey === MAIL_CALLER && receipt.method === 'agentSession.send') {
        if (
          receipt.status === 'accepted' &&
          receipt.result.kind === 'queued-draft' &&
          receipt.result.messageId === operationId
        ) {
          return { operationId, state: 'accepted', evidence }
        }
        if (
          receipt.status === 'rejected' &&
          (receipt.rejection.reference.details?.reason === 'queueTooLarge' ||
            receipt.rejection.reference.code === 'execution_owner_reconciling' ||
            receipt.rejection.reference.code === 'agent_session_operation_unknown')
        ) {
          return { operationId, state: 'unknown', evidence }
        }
      }
    }
    if (operation?.outcome.status === 'pending' || operation?.outcome.status === 'unknown') {
      return { operationId, state: 'unknown', evidence }
    }
    if (!rows.length && !operation) {
      return { operationId, state: 'absent', evidence }
    }
    if (host.deps.journalDatabase.readOnly) {
      return { operationId, state: 'unknown', evidence }
    }
    const blocker = digest([rows, operation])
    blockers.push(blocker)
    operationId = `0000000000001-${digest([
      'ordinary-mail-recovery-v1',
      source.run_id,
      source.id,
      operationId,
      blocker
    ]).slice(0, 32)}`
  }
}
