/**
 * The agent-session operation id one structured worker mailbox's pointer send runs under.
 *
 * Orchestration's own `msg_<hex>` ids do not match the host's `^\d{13}-[0-9a-f]{32}$` shape and are
 * refused before the first send, so the id is minted here instead. It is durable and reused across
 * retries, because the id IS the send's idempotency key: a fresh id for the same nudge would land
 * as a second turn. It is re-minted only when the send is genuinely a different call — a different
 * batch of mail, or a different session — or when the host would reject it as too old to admit.
 *
 * Reuse is keyed on the MESSAGE IDS in the batch, never on the pointer body: the body names only
 * how many messages are waiting, so two unrelated same-size batches share a fingerprint. Reusing a
 * live id across them makes the host answer from its operation ledger — `accepted`, with no turn
 * sent — and this lane then marks the new mail delivered. That is silent mail loss.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../../shared/agent-session-host-authority'
import type { OrchestrationDb } from './db'

export function mintAgentSessionOperationId(now: number): string {
  return `${String(now).padStart(13, '0')}-${randomBytes(16).toString('hex')}`
}

/** Batch identity, and the only thing reuse may be keyed on. */
export function structuredPointerBatchFingerprint(
  sessionId: string,
  messageIds: readonly string[]
): string {
  return createHash('sha256')
    .update(JSON.stringify([sessionId, messageIds]))
    .digest('base64url')
}

export function structuredPointerPayloadFingerprint(
  sessionId: string,
  body: AgentJournalMessageItem
): string {
  return computeAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId,
    fields: { body }
  })
}

export function resolveStructuredPointerOperation(args: {
  db: OrchestrationDb
  mailboxHandle: string
  sessionId: string
  body: AgentJournalMessageItem
  /** The rows this nudge stands for; batch identity, not the body, decides reuse. */
  messageIds: readonly string[]
  now?: number
}): { operationId: string; payloadFingerprint: string } {
  const now = args.now ?? Date.now()
  const payloadFingerprint = structuredPointerPayloadFingerprint(args.sessionId, args.body)
  const batchFingerprint = structuredPointerBatchFingerprint(args.sessionId, args.messageIds)
  const stored = args.db.getStructuredPointerOperation(args.mailboxHandle)
  if (
    stored &&
    stored.session_id === args.sessionId &&
    stored.batch_fingerprint === batchFingerprint &&
    now - stored.minted_at_ms < AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS
  ) {
    return { operationId: stored.operation_id, payloadFingerprint }
  }
  const operationId = mintAgentSessionOperationId(now)
  args.db.putStructuredPointerOperation({
    mailbox_handle: args.mailboxHandle,
    session_id: args.sessionId,
    operation_id: operationId,
    batch_fingerprint: batchFingerprint,
    minted_at_ms: now
  })
  return { operationId, payloadFingerprint }
}
