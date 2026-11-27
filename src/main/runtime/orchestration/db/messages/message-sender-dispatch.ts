import { z } from 'zod'
import { lazyZodSchema } from '../../../../../shared/schema/lazy-zod-schema'
import type { OrchestrationDb } from '../orchestration-db'
import { workerIdentity, type WorkerIdentity } from '../../workers/identity/worker-identity'

type SenderSnapshot = Pick<WorkerIdentity, 'title' | 'agent' | 'hostLabel'>

/** Records which Dispatch's worker sent a message, with who it was then, so its card can name it after
 *  its chat or terminal is gone. Immutable once written. */
export function recordMessageSenderDispatch(
  db: OrchestrationDb,
  messageId: string,
  dispatchId: string
): void {
  const identity = workerIdentity(db, dispatchId)
  if (!identity) {
    return
  }
  const snapshot: SenderSnapshot = {
    title: identity.title,
    agent: identity.agent,
    hostLabel: identity.hostLabel
  }
  db.db
    .prepare(
      `INSERT OR IGNORE INTO message_dispatch_provenance (message_id, dispatch_id, task_id, sender_snapshot)
       VALUES (?, ?, ?, ?)`
    )
    .run(messageId, dispatchId, identity.taskId, JSON.stringify(snapshot))
}

/** The worker a message was recorded from; null for mail from no worker, or written before it was recorded. */
export function readMessageSenderDispatch(
  db: OrchestrationDb,
  messageId: string
): WorkerIdentity | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT of three TEXT columns by primary key.
  const row = db.db
    .prepare(
      `SELECT dispatch_id, task_id, sender_snapshot FROM message_dispatch_provenance WHERE message_id = ?`
    )
    .get(messageId) as
    | { dispatch_id: string; task_id: string; sender_snapshot: string | null }
    | undefined
  if (!row) {
    return null
  }
  const snapshot = parseSenderSnapshot(row.sender_snapshot)
  // A row a peer Run or an import wrote before snapshots were kept is named from its Dispatch now.
  return snapshot
    ? { dispatchId: row.dispatch_id, taskId: row.task_id, ...snapshot }
    : workerIdentity(db, row.dispatch_id)
}

const OptionalText = lazyZodSchema(() => z.string().nullable().catch(null))
const StoredSenderSnapshot = lazyZodSchema(() =>
  z.object({
    title: OptionalText,
    agent: OptionalText,
    hostLabel: OptionalText
  })
)

function parseSenderSnapshot(json: string | null): SenderSnapshot | null {
  try {
    const parsed = StoredSenderSnapshot.safeParse(json ? JSON.parse(json) : null)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
