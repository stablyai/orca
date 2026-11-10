// Messages to a workspace's agent: written as `queued` first, then delivered once the VM is up
// (waking it if it sleeps). A crash between the two leaves a queued row the cron retries.
import { LifecycleError, resumeSandbox, type LifecycleDeps } from '../lifecycle'
import { getSandbox } from '../store'
import { withSenderEnvelope, parseSenderEnvelope } from '../../../../../src/shared/cloud-workspaces/sender-envelope'
import { memberNamesFor } from '../member-names'
import { randomId } from './keys'
import { launchAgent, sendToSession, VmAgentError, type AgentId } from './vm-agent'
import type { WorkspaceRow } from './workspaces'

export type MessageStatus = 'queued' | 'delivering' | 'delivered' | 'failed'

export type MessageRow = {
  id: string
  sandbox_id: string
  account_id: string
  sent_by: string
  agent: AgentId
  session_handle: string | null
  body: string
  status: MessageStatus
  attempts: number
  result_handle: string | null
  error: string | null
  created_at: number
  updated_at: number
  delivered_at: number | null
}

export const MAX_MESSAGE_CHARS = 32_000
const MAX_ATTEMPTS = 4
/** A delivery claimed this long ago without finishing is presumed dead and retried. */
const DELIVERY_STALE_MS = 3 * 60_000

export function messageView(row: MessageRow, names: ReadonlyMap<string, string> = new Map()) {
  return {
    id: row.id,
    workspaceId: row.sandbox_id,
    agent: row.agent,
    sentBy: row.sent_by,
    sentByName: names.get(row.sent_by) ?? null,
    status: row.status,
    // The session that received it: pass back as `session` to continue the same conversation.
    session: row.result_handle ?? row.session_handle,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at
  }
}

export async function queueMessage(
  db: D1Database,
  input: { workspace: WorkspaceRow; sentBy: string; agent: AgentId; text: string; session?: string | null },
  now: number
): Promise<MessageRow> {
  const id = randomId('msg')
  await db
    .prepare(
      `INSERT INTO workspace_messages (id, sandbox_id, account_id, sent_by, agent, session_handle, body, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
    )
    .bind(id, input.workspace.id, input.workspace.account_id, input.sentBy, input.agent, input.session ?? null, input.text, now, now)
    .run()
  return (await getMessage(db, id))!
}

export function getMessage(db: D1Database, id: string): Promise<MessageRow | null> {
  return db.prepare('SELECT * FROM workspace_messages WHERE id = ?').bind(id).first<MessageRow>()
}

export async function listMessages(db: D1Database, sandboxId: string, limit: number): Promise<MessageRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM workspace_messages WHERE sandbox_id = ? ORDER BY created_at DESC LIMIT ?')
    .bind(sandboxId, limit)
    .all<MessageRow>()
  return results
}

/**
 * Compare-and-set claim of a queued message so two isolates never type it twice. The claim token
 * (attempt number) is what `settle` must match: a slow worker can never overwrite a newer result.
 */
async function claim(db: D1Database, row: MessageRow, now: number): Promise<number | null> {
  const result = await db
    .prepare(
      `UPDATE workspace_messages SET status = 'delivering', attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND attempts = ? AND status = 'queued'`
    )
    .bind(now, row.id, row.attempts)
    .run()
  return result.meta.changes === 1 ? row.attempts + 1 : null
}

async function settle(
  db: D1Database,
  id: string,
  attempt: number,
  patch: { status: MessageStatus; result_handle?: string | null; error?: string | null },
  now: number
) {
  await db
    .prepare(
      `UPDATE workspace_messages SET status = ?, result_handle = COALESCE(?, result_handle), error = ?, updated_at = ?,
         delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END
       WHERE id = ? AND attempts = ? AND status = 'delivering'`
    )
    .bind(patch.status, patch.result_handle ?? null, patch.error ?? null, now, patch.status, now, id, attempt)
    .run()
}

/**
 * Delivers one queued message: wakes the workspace if needed, then continues the named session or
 * starts a new agent session with the text as its first prompt.
 */
export async function deliverMessage(life: LifecycleDeps, message: MessageRow): Promise<MessageRow> {
  const attempt = await claim(life.db, message, life.now())
  if (attempt === null) {
    return (await getMessage(life.db, message.id)) ?? message
  }
  try {
    let row = await getSandbox(life.db, message.sandbox_id)
    if (!row || row.status === 'destroyed' || row.status === 'destroying') {
      throw new VmAgentError('workspace_gone')
    }
    if (row.status !== 'running' || !row.session_id) {
      row = (await resumeSandbox(life, row)).row
    }
    const sessionId = row.session_id!
    // A teammate's message names its sender (W4: agents address them and commit as them via
    // `orca-git-as`); nobody can type a leading envelope to impersonate someone else.
    const text =
      message.sent_by === row.user_id
        ? parseSenderEnvelope(message.body).body
        : withSenderEnvelope(message.body, {
            userId: message.sent_by,
            name: (await memberNamesFor(life.db, message.account_id, [message.sent_by])).get(message.sent_by) ?? message.sent_by
          })
    let handle: string
    if (message.session_handle) {
      await sendToSession(life.provider, sessionId, message.session_handle, text)
      handle = message.session_handle
    } else {
      handle = await launchAgent(life.provider, sessionId, message.agent, text)
    }
    await settle(life.db, message.id, attempt, { status: 'delivered', result_handle: handle, error: null }, life.now())
  } catch (error) {
    const code = error instanceof VmAgentError || error instanceof LifecycleError ? error.code : 'delivery_failed'
    const permanent = code === 'workspace_gone' || code === 'terminal_not_found' || code === 'selector_not_found' || attempt >= MAX_ATTEMPTS
    // Codes only: never the provider body or the message text.
    console.log(JSON.stringify({ event: 'message_delivery_failed', messageId: message.id, code, permanent }))
    await settle(life.db, message.id, attempt, { status: permanent ? 'failed' : 'queued', error: code }, life.now())
  }
  return (await getMessage(life.db, message.id))!
}

/**
 * Cron: retry queued messages. A delivery whose worker died mid-way may already have reached the
 * agent, so it is not re-sent blindly: it fails with `delivery_outcome_unknown` and the caller
 * decides (GET /sessions shows whether the agent got it).
 */
export async function retryPendingMessages(life: LifecycleDeps, limit = 20): Promise<number> {
  const now = life.now()
  await life.db
    .prepare(
      `UPDATE workspace_messages SET status = 'failed', error = 'delivery_outcome_unknown', updated_at = ?
       WHERE status = 'delivering' AND updated_at < ?`
    )
    .bind(now, now - DELIVERY_STALE_MS)
    .run()
  const { results } = await life.db
    .prepare(`SELECT * FROM workspace_messages WHERE status = 'queued' AND updated_at < ? ORDER BY created_at LIMIT ?`)
    .bind(now - 30_000, limit)
    .all<MessageRow>()
  for (const row of results) {
    await deliverMessage(life, row)
  }
  return results.length
}
