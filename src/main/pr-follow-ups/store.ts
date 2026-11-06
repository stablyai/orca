import Database from '../sqlite/sync-database'
import {
  activityOverlaps,
  followUpActivityIdentity,
  type FollowUpActivityKind,
  type FollowUpActivity
} from './activity-journal'
import type { FollowUpAction, FollowUpPr } from '../../shared/pr-follow-ups/contracts'

export class FollowUpStore {
  private commits: FollowUpAction[] | undefined
  actionCommitted?: (action: FollowUpAction) => void
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS followup_pr (pr_key TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS followup_binding (pr_key TEXT NOT NULL, instance_id TEXT NOT NULL,
        PRIMARY KEY (pr_key, instance_id));
      CREATE TABLE IF NOT EXISTS followup_action (action_key TEXT PRIMARY KEY, pr_key TEXT NOT NULL,
        payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS followup_activity (sequence INTEGER PRIMARY KEY,
        instance_id TEXT NOT NULL, identity TEXT NOT NULL, operation_id TEXT NOT NULL,
        at INTEGER NOT NULL, kind TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS followup_activity_window ON followup_activity(instance_id, identity, at, (kind = 'started') DESC, sequence);
      CREATE INDEX IF NOT EXISTS followup_activity_decisive ON followup_activity(instance_id, identity, at DESC, (kind = 'started') ASC, sequence DESC) WHERE kind != 'unknown';
      CREATE INDEX IF NOT EXISTS followup_activity_revision ON followup_activity(instance_id, sequence DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS followup_activity_start ON followup_activity(operation_id) WHERE kind = 'started';
      CREATE INDEX IF NOT EXISTS followup_action_instance ON followup_action(json_extract(payload, '$.instanceId'));
      CREATE INDEX IF NOT EXISTS followup_action_pr ON followup_action(pr_key);
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS followup_action_pending ON followup_action(pr_key) WHERE (json_extract(payload, '$.status') IN ('claimed', 'unconfirmed') AND json_extract(payload, '$.recoveryFinalizedAt') IS NULL OR (json_extract(payload, '$.status') = 'accepted' AND json_extract(payload, '$.sessionEndedAt') IS NULL));
      CREATE INDEX IF NOT EXISTS followup_action_session ON followup_action(json_extract(payload, '$.sessionId'));
      CREATE INDEX IF NOT EXISTS followup_action_pane ON followup_action(json_extract(payload, '$.paneKey'));
      CREATE INDEX IF NOT EXISTS followup_action_pty ON followup_action(json_extract(payload, '$.terminalPtyId'));
      CREATE INDEX IF NOT EXISTS followup_action_status ON followup_action(pr_key, json_extract(payload, '$.status'), json_extract(payload, '$.sessionEndedAt'));
      CREATE INDEX IF NOT EXISTS followup_action_generation ON followup_action(pr_key, json_extract(payload, '$.status'), json_extract(payload, '$.generation'));
      CREATE INDEX IF NOT EXISTS followup_action_started ON followup_action(pr_key, json_extract(payload, '$.status'), COALESCE(json_extract(payload, '$.sessionStartedAt'), json_extract(payload, '$.attemptStartedAt')));
      CREATE INDEX IF NOT EXISTS followup_action_latest ON followup_action(pr_key, json_extract(payload, '$.attemptStartedAt') DESC);
    `)
  }

  static open(path: string): FollowUpStore {
    const db = new Database(path)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = FULL')
    db.pragma('busy_timeout = 5000')
    return new FollowUpStore(db)
  }

  transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    this.commits = []
    try {
      const result = run()
      this.db.exec('COMMIT')
      const commits = this.commits
      this.commits = undefined
      for (const action of commits) {
        this.actionCommitted?.(action)
      }
      return result
    } catch (error) {
      this.commits = undefined
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  prs(): FollowUpPr[] {
    return this.db
      .prepare('SELECT payload FROM followup_pr')
      .all()
      .map((row) => JSON.parse(String(row.payload)))
  }

  pr(prKey: string): FollowUpPr | undefined {
    const row = this.db.prepare('SELECT payload FROM followup_pr WHERE pr_key = ?').get(prKey)
    return row ? JSON.parse(String(row.payload)) : undefined
  }

  savePr(pr: FollowUpPr): void {
    this.db
      .prepare(
        'INSERT INTO followup_pr VALUES (?, ?) ON CONFLICT(pr_key) DO UPDATE SET payload = excluded.payload WHERE payload != excluded.payload'
      )
      .run(pr.prKey, JSON.stringify(pr))
  }

  actions(prKey: string, pendingOnly = false): FollowUpAction[] {
    return this.db
      .prepare(
        `SELECT payload FROM followup_action${pendingOnly ? ' INDEXED BY followup_action_pending' : ''} WHERE pr_key = ?${pendingOnly ? " AND (json_extract(payload, '$.status') IN ('claimed', 'unconfirmed') AND json_extract(payload, '$.recoveryFinalizedAt') IS NULL OR (json_extract(payload, '$.status') = 'accepted' AND json_extract(payload, '$.sessionEndedAt') IS NULL))" : ''}`
      )
      .all(prKey)
      .map((row) => JSON.parse(String(row.payload)))
  }

  pendingActions(): FollowUpAction[] {
    return this.db
      .prepare(
        "SELECT payload FROM followup_action INDEXED BY followup_action_pending WHERE (json_extract(payload, '$.status') IN ('claimed', 'unconfirmed') AND json_extract(payload, '$.recoveryFinalizedAt') IS NULL OR (json_extract(payload, '$.status') = 'accepted' AND json_extract(payload, '$.sessionEndedAt') IS NULL))"
      )
      .all()
      .map((row) => JSON.parse(String(row.payload)))
  }

  actionsForIdentity(identity: string): FollowUpAction[] {
    return this.db
      .prepare(
        "SELECT payload FROM followup_action WHERE json_extract(payload, '$.sessionId') = ? OR json_extract(payload, '$.terminalPtyId') = ? OR json_extract(payload, '$.paneKey') = ?"
      )
      .all(identity, identity, identity)
      .map((row) => JSON.parse(String(row.payload)))
  }

  action(actionKey: string): FollowUpAction | undefined {
    const row = this.db
      .prepare('SELECT payload FROM followup_action WHERE action_key = ?')
      .get(actionKey)
    return row ? JSON.parse(String(row.payload)) : undefined
  }

  latestAction(prKey: string): FollowUpAction | undefined {
    const row = this.db
      .prepare(
        "SELECT payload FROM followup_action WHERE pr_key = ? ORDER BY json_extract(payload, '$.attemptStartedAt') DESC LIMIT 1"
      )
      .get(prKey)
    return row ? JSON.parse(String(row.payload)) : undefined
  }

  acceptedCount(prKey: string, generation: number): number {
    return Number(
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM followup_action WHERE pr_key = ? AND json_extract(payload, '$.status') IN ('accepted', 'claimed', 'unconfirmed') AND json_extract(payload, '$.generation') = ?"
        )
        .get(prKey, generation)?.count ?? 0
    )
  }

  recentAcceptedStarts(prKey: string, since: number): number[] {
    return this.db
      .prepare(
        "SELECT COALESCE(json_extract(payload, '$.sessionStartedAt'), json_extract(payload, '$.attemptStartedAt')) AS started FROM followup_action WHERE pr_key = ? AND json_extract(payload, '$.status') IN ('accepted', 'claimed', 'unconfirmed') AND COALESCE(json_extract(payload, '$.sessionStartedAt'), json_extract(payload, '$.attemptStartedAt')) > ? ORDER BY started ASC"
      )
      .all(prKey, since)
      .map((row) => Number(row.started))
  }

  saveAction(action: FollowUpAction): void {
    this.db
      .prepare(
        'INSERT INTO followup_action(action_key, pr_key, payload) VALUES (?, ?, ?) ON CONFLICT(action_key) DO UPDATE SET payload = excluded.payload WHERE payload != excluded.payload'
      )
      .run(action.actionKey, action.prKey, JSON.stringify(action))
    if (action.status === 'accepted') {
      this.seedActivity(action)
    }
    if (this.commits) {
      this.commits.push({ ...action })
    } else {
      this.actionCommitted?.(action)
    }
  }

  pushAttributed(prKey: string, chatId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM followup_action WHERE pr_key = ? AND json_extract(payload, '$.status') = 'accepted' AND (json_extract(payload, '$.sessionId') = ? OR json_extract(payload, '$.transcriptChatId') = ?) LIMIT 1"
        )
        .get(prKey, chatId, chatId)
    )
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
    const streams = this.db
      .prepare(
        "SELECT json_extract(payload, '$.instanceId') AS instance, COALESCE(json_extract(payload, '$.paneKey'), json_extract(payload, '$.sessionId'), json_extract(payload, '$.terminalPtyId'), json_extract(payload, '$.operationId')) AS identity, COALESCE(json_extract(payload, '$.sessionStartedAt'), json_extract(payload, '$.attemptStartedAt')) AS start, json_extract(payload, '$.sessionEndedAt') AS end FROM followup_action WHERE pr_key = ? AND json_extract(payload, '$.status') = 'accepted'"
      )
      .all(prKey)
    return streams.some(
      (row) =>
        Number(row.start) <= to &&
        (row.end === null || Number(row.end) >= from) &&
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

  bind(prKey: string, instanceId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO followup_binding VALUES (?, ?)').run(prKey, instanceId)
  }

  deleteBinding(instanceId: string): string[] {
    const keys = this.db
      .prepare('SELECT pr_key FROM followup_binding WHERE instance_id = ?')
      .all(instanceId)
      .map((row) => String(row.pr_key))
    this.db.prepare('DELETE FROM followup_binding WHERE instance_id = ?').run(instanceId)
    return keys
  }

  reconcileBindings(liveInstanceIds: ReadonlySet<string>): string[] {
    const affected = new Set<string>()
    for (const row of this.db.prepare('SELECT pr_key, instance_id FROM followup_binding').all()) {
      if (!liveInstanceIds.has(String(row.instance_id))) {
        affected.add(String(row.pr_key))
        this.db
          .prepare('DELETE FROM followup_binding WHERE pr_key = ? AND instance_id = ?')
          .run(row.pr_key, row.instance_id)
      }
    }
    return [...affected]
  }

  retire(pr: FollowUpPr): boolean {
    const bound = this.db
      .prepare('SELECT 1 FROM followup_binding WHERE pr_key = ? LIMIT 1')
      .get(pr.prKey)
    const pending = this.actions(pr.prKey, true).length > 0
    if ((bound && (pr.state === 'open' || pr.state === 'draft')) || pending) {
      return false
    }
    this.transaction(() => {
      const instances = this.db
        .prepare(
          "SELECT DISTINCT json_extract(payload, '$.instanceId') AS instance FROM followup_action WHERE pr_key = ?"
        )
        .all(pr.prKey)
      this.db.prepare('DELETE FROM followup_action WHERE pr_key = ?').run(pr.prKey)
      for (const row of instances) {
        this.db
          .prepare(
            "DELETE FROM followup_activity WHERE instance_id = ? AND NOT EXISTS (SELECT 1 FROM followup_action WHERE json_extract(payload, '$.instanceId') = ?)"
          )
          .run(row.instance, row.instance)
      }
      this.db.prepare('DELETE FROM followup_binding WHERE pr_key = ?').run(pr.prKey)
      this.db.prepare('DELETE FROM followup_pr WHERE pr_key = ?').run(pr.prKey)
    })
    return true
  }

  close(): void {
    this.db.close()
  }
}
