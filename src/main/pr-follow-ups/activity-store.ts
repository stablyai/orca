import type Database from '../sqlite/sync-database'
import {
  activityOverlaps,
  followUpActivityIdentity,
  type FollowUpActivityKind,
  type FollowUpActivity
} from './activity-journal'
import type { FollowUpAction } from '../../shared/pr-follow-ups/contracts'

export class FollowUpActivityStore {
  constructor(protected readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS followup_activity (sequence INTEGER PRIMARY KEY,
        instance_id TEXT NOT NULL, identity TEXT NOT NULL, operation_id TEXT NOT NULL,
        at INTEGER NOT NULL, kind TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS followup_activity_window ON followup_activity(instance_id, identity, at, (kind = 'started') DESC, sequence);
      CREATE INDEX IF NOT EXISTS followup_activity_decisive ON followup_activity(instance_id, identity, at DESC, (kind = 'started') ASC, sequence DESC) WHERE kind != 'unknown';
      CREATE INDEX IF NOT EXISTS followup_activity_revision ON followup_activity(instance_id, sequence DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS followup_activity_start ON followup_activity(operation_id) WHERE kind = 'started';
    `)
  }

  protected pruneActivity(instance: string): void {
    this.db
      .prepare(
        "DELETE FROM followup_activity WHERE instance_id = ? AND NOT EXISTS (SELECT 1 FROM followup_action WHERE json_extract(payload, '$.instanceId') = ?)"
      )
      .run(instance, instance)
  }

  reconcileActivity(
    instance: string,
    identity: string,
    kind: 'working' | 'idle' | 'unknown',
    at: number,
    operation: string
  ): void {
    const latest = this.db
      .prepare(
        "SELECT at, kind FROM followup_activity INDEXED BY followup_activity_decisive WHERE instance_id = ? AND identity = ? AND kind != 'unknown' ORDER BY at DESC, (kind = 'started') ASC, sequence DESC LIMIT 1"
      )
      .get(instance, identity)
    if (
      kind === 'unknown' ||
      (latest &&
        (Number(latest.at) > at || (latest.kind === 'started' ? 'working' : latest.kind) === kind))
    ) {
      return
    }
    this.appendActivity(instance, identity, kind, at, operation)
  }

  appendActivity(
    instance: string,
    identity: string,
    kind: FollowUpActivityKind,
    at: number,
    operation = ''
  ): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO followup_activity(instance_id, identity, operation_id, at, kind) VALUES (?, ?, ?, ?, ?)'
      )
      .run(instance, identity, operation, at, kind)
  }

  activityRevision(instance: string): number {
    return Number(
      this.db
        .prepare(
          'SELECT sequence FROM followup_activity WHERE instance_id = ? ORDER BY sequence DESC LIMIT 1'
        )
        .get(instance)?.sequence ?? 0
    )
  }

  activityWindow(instance: string, identity: string, from: number, to: number): FollowUpActivity[] {
    const before = this.db
      .prepare(
        "SELECT at, kind FROM followup_activity INDEXED BY followup_activity_decisive WHERE instance_id = ? AND identity = ? AND kind != 'unknown' AND at < ? ORDER BY at DESC, (kind = 'started') ASC, sequence DESC LIMIT 1"
      )
      .get(instance, identity, from)
    const rows = this.db
      .prepare(
        "SELECT at, kind FROM followup_activity WHERE instance_id = ? AND identity = ? AND at >= ? AND at <= ? ORDER BY at, (kind = 'started') DESC, sequence"
      )
      .all(instance, identity, from, to)
    return [...(before ? [before] : []), ...rows].map((row) => ({
      at: Number(row.at),
      kind: String(row.kind) as FollowUpActivityKind
    }))
  }

  workingOverlap(prKey: string, from: number, to: number): boolean {
    const columns =
      "json_extract(payload, '$.instanceId') AS instance, COALESCE(json_extract(payload, '$.paneKey'), json_extract(payload, '$.sessionId'), json_extract(payload, '$.terminalPtyId'), json_extract(payload, '$.operationId')) AS identity, json_extract(payload, '$.sessionEndedAt') AS end"
    const streams = this.db
      .prepare(`
      SELECT ${columns} FROM followup_action INDEXED BY followup_action_live_window
      WHERE pr_key = ? AND json_extract(payload, '$.status') = 'accepted' AND json_extract(payload, '$.sessionEndedAt') IS NULL
        AND COALESCE(json_extract(payload, '$.sessionStartedAt'), json_extract(payload, '$.attemptStartedAt')) <= ?
      UNION ALL
      SELECT ${columns} FROM followup_action INDEXED BY followup_action_ended_window
      WHERE pr_key = ? AND json_extract(payload, '$.status') = 'accepted' AND json_extract(payload, '$.sessionEndedAt') IS NOT NULL
        AND json_extract(payload, '$.sessionEndedAt') >= ?
        AND COALESCE(json_extract(payload, '$.sessionStartedAt'), json_extract(payload, '$.attemptStartedAt')) <= ?
    `)
      .all(prKey, to, prKey, from, to)
    return streams.some((row) =>
      activityOverlaps(
        this.activityWindow(
          String(row.instance),
          String(row.identity),
          from,
          Math.min(to, row.end === null ? to : Number(row.end))
        ),
        from,
        to
      )
    )
  }

  seedActivity(action: FollowUpAction): void {
    this.appendActivity(
      action.instanceId,
      followUpActivityIdentity(action),
      'started',
      action.sessionStartedAt ?? action.attemptStartedAt,
      action.operationId
    )
  }
}
