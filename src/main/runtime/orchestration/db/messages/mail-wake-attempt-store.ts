// A mail wake main starts for a slept pane: claimed here before the pane is asked to resume, given
// its process once one starts, and deleted when the agent confirms or nothing is owed any more.
import type { OrchestrationDb } from '../orchestration-db'
import { sleepingAgentSessionRecordSchema } from '../../../../../shared/workspace-session/workspace-session-sleeping-agents'
import type { SleptMailRecord } from '../../mailbox/routing/mail-wake-obligation'

export const MAIL_WAKE_ATTEMPT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mail_wake_attempts (
  pane_key       TEXT PRIMARY KEY,
  id             TEXT NOT NULL,
  record         TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  pty_id         TEXT,
  incarnation_id TEXT,
  launch_token   TEXT
);
`

type MailWakeLaunch = { ptyId: string; incarnationId: string; launchToken: string }

/** False when this pane already has an attempt: one wake per slept pane at a time. */
export function claimMailWake(
  this: OrchestrationDb,
  record: SleptMailRecord,
  id: string,
  startedAt: number
): boolean {
  const { mailWake: _none, ...slept } = record
  return (
    this.db
      .prepare(
        'INSERT OR IGNORE INTO mail_wake_attempts (pane_key, id, record, started_at) VALUES (?, ?, ?, ?)'
      )
      .run(record.paneKey, id, JSON.stringify(slept), startedAt).changes === 1
  )
}

export function recordMailWakeLaunch(
  this: OrchestrationDb,
  paneKey: string,
  id: string,
  launch: MailWakeLaunch
): boolean {
  return (
    this.db
      .prepare(`UPDATE mail_wake_attempts SET pty_id = ?, incarnation_id = ?, launch_token = ?
        WHERE pane_key = ? AND id = ? AND pty_id IS NULL`)
      .run(launch.ptyId, launch.incarnationId, launch.launchToken, paneKey, id).changes === 1
  )
}

export function settleMailWake(this: OrchestrationDb, paneKey: string, id: string): boolean {
  return (
    this.db.prepare('DELETE FROM mail_wake_attempts WHERE pane_key = ? AND id = ?').run(paneKey, id)
      .changes === 1
  )
}

/** Every stored attempt as the slept record it resumes; an unreadable row is dropped. */
export function listMailWakeAttempts(this: OrchestrationDb): SleptMailRecord[] {
  const attempts: SleptMailRecord[] = []
  for (const row of this.db.prepare('SELECT * FROM mail_wake_attempts').all()) {
    const parsed =
      typeof row.record === 'string'
        ? sleepingAgentSessionRecordSchema.safeParse(parseStoredRecord(row.record))
        : null
    if (
      !parsed?.success ||
      typeof row.id !== 'string' ||
      typeof row.pane_key !== 'string' ||
      typeof row.started_at !== 'number'
    ) {
      this.db.prepare('DELETE FROM mail_wake_attempts WHERE pane_key = ?').run(row.pane_key)
      continue
    }
    const { pty_id: ptyId, incarnation_id: incarnationId, launch_token: launchToken } = row
    attempts.push({
      ...parsed.data,
      paneKey: row.pane_key,
      mailWake: {
        id: row.id,
        startedAt: row.started_at,
        ...(typeof ptyId === 'string' &&
        typeof incarnationId === 'string' &&
        typeof launchToken === 'string'
          ? { attempt: { ptyId, incarnationId, launchToken, startedAt: row.started_at } }
          : {})
      }
    })
  }
  return attempts
}

export type MailWakeAttemptStoreMethods = {
  claimMailWake: typeof claimMailWake
  recordMailWakeLaunch: typeof recordMailWakeLaunch
  settleMailWake: typeof settleMailWake
  listMailWakeAttempts: typeof listMailWakeAttempts
}

export function attachMailWakeAttemptStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    claimMailWake,
    recordMailWakeLaunch,
    settleMailWake,
    listMailWakeAttempts
  })
}

function parseStoredRecord(record: string): unknown {
  try {
    return JSON.parse(record)
  } catch {
    return null
  }
}
