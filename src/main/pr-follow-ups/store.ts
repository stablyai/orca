import Database from '../sqlite/sync-database'
import type {
  FollowUpAction,
  FollowUpActionMetadata,
  FollowUpPr
} from '../../shared/pr-follow-ups/contracts'

export class FollowUpStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS followup_pr (pr_key TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS followup_binding (pr_key TEXT NOT NULL, instance_id TEXT NOT NULL,
        PRIMARY KEY (pr_key, instance_id));
      CREATE TABLE IF NOT EXISTS followup_action (action_key TEXT PRIMARY KEY, pr_key TEXT NOT NULL,
        payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS followup_action_pr ON followup_action(pr_key);
    `)
    if (
      !db
        .prepare('PRAGMA table_info(followup_action)')
        .all()
        .some((column) => column.name === 'metadata')
    ) {
      this.transaction(() =>
        db.exec(`ALTER TABLE followup_action ADD COLUMN metadata TEXT;
        UPDATE followup_action SET metadata = json_set(json_remove(payload, '$.launch'),
          '$.agent', json_extract(payload, '$.launch.agent'));`)
      )
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS followup_action_status ON followup_action(pr_key, json_extract(metadata, '$.status'), json_extract(metadata, '$.sessionEndedAt'));
      CREATE INDEX IF NOT EXISTS followup_action_generation ON followup_action(pr_key, json_extract(metadata, '$.status'), json_extract(metadata, '$.generation'));
      CREATE INDEX IF NOT EXISTS followup_action_started ON followup_action(pr_key, json_extract(metadata, '$.status'), COALESCE(json_extract(metadata, '$.sessionStartedAt'), json_extract(metadata, '$.attemptStartedAt')));
      CREATE INDEX IF NOT EXISTS followup_action_latest ON followup_action(pr_key, json_extract(metadata, '$.attemptStartedAt') DESC);
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
    try {
      const result = run()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
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
        'INSERT INTO followup_pr VALUES (?, ?) ON CONFLICT(pr_key) DO UPDATE SET payload = excluded.payload'
      )
      .run(pr.prKey, JSON.stringify(pr))
  }

  actions(prKey: string): FollowUpAction[] {
    return this.metadata(prKey).map((action) => this.action(action.actionKey)!)
  }

  action(actionKey: string): FollowUpAction | undefined {
    const row = this.db
      .prepare('SELECT metadata, payload FROM followup_action WHERE action_key = ?')
      .get(actionKey)
    return row
      ? { ...JSON.parse(String(row.metadata)), launch: JSON.parse(String(row.payload)).launch }
      : undefined
  }

  metadata(prKey: string, pendingOnly = false): FollowUpActionMetadata[] {
    return this.db
      .prepare(
        `SELECT metadata FROM followup_action WHERE pr_key = ?${pendingOnly ? " AND (json_extract(metadata, '$.status') IN ('claimed', 'unconfirmed') OR (json_extract(metadata, '$.status') = 'accepted' AND json_extract(metadata, '$.sessionEndedAt') IS NULL))" : ''}`
      )
      .all(prKey)
      .map((row) => JSON.parse(String(row.metadata)))
  }

  latestAction(prKey: string): FollowUpActionMetadata | undefined {
    const row = this.db
      .prepare(
        "SELECT metadata FROM followup_action WHERE pr_key = ? AND json_extract(metadata, '$.status') != 'absent' ORDER BY json_extract(metadata, '$.attemptStartedAt') DESC LIMIT 1"
      )
      .get(prKey)
    return row ? JSON.parse(String(row.metadata)) : undefined
  }

  acceptedCount(prKey: string, generation: number): number {
    return Number(
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM followup_action WHERE pr_key = ? AND json_extract(metadata, '$.status') = 'accepted' AND json_extract(metadata, '$.generation') = ?"
        )
        .get(prKey, generation)?.count ?? 0
    )
  }

  recentAcceptedStarts(prKey: string, since: number): number[] {
    return this.db
      .prepare(
        "SELECT COALESCE(json_extract(metadata, '$.sessionStartedAt'), json_extract(metadata, '$.attemptStartedAt')) AS started FROM followup_action WHERE pr_key = ? AND json_extract(metadata, '$.status') = 'accepted' AND COALESCE(json_extract(metadata, '$.sessionStartedAt'), json_extract(metadata, '$.attemptStartedAt')) > ? ORDER BY started ASC"
      )
      .all(prKey, since)
      .map((row) => Number(row.started))
  }

  saveAction(action: FollowUpAction): void {
    const { launch, ...metadata } = action
    this.db
      .prepare(
        'INSERT INTO followup_action (action_key, pr_key, payload, metadata) VALUES (?, ?, ?, ?) ON CONFLICT(action_key) DO UPDATE SET payload = excluded.payload, metadata = excluded.metadata'
      )
      .run(
        action.actionKey,
        action.prKey,
        JSON.stringify({ launch }),
        JSON.stringify({ ...metadata, agent: launch.agent })
      )
  }

  saveActionMetadata(action: FollowUpActionMetadata): void {
    this.db
      .prepare('UPDATE followup_action SET metadata = ? WHERE action_key = ?')
      .run(JSON.stringify(action), action.actionKey)
  }

  bind(prKey: string, instanceId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO followup_binding VALUES (?, ?)').run(prKey, instanceId)
  }

  reconcileBindings(liveInstanceIds: ReadonlySet<string>): void {
    for (const row of this.db.prepare('SELECT pr_key, instance_id FROM followup_binding').all()) {
      if (!liveInstanceIds.has(String(row.instance_id))) {
        this.db
          .prepare('DELETE FROM followup_binding WHERE pr_key = ? AND instance_id = ?')
          .run(row.pr_key, row.instance_id)
      }
    }
  }

  retire(pr: FollowUpPr): boolean {
    const bound = this.db
      .prepare('SELECT 1 FROM followup_binding WHERE pr_key = ? LIMIT 1')
      .get(pr.prKey)
    const pending = this.metadata(pr.prKey, true).length > 0
    if ((bound && pr.state === 'open') || pending) {
      return false
    }
    this.transaction(() => {
      this.db.prepare('DELETE FROM followup_action WHERE pr_key = ?').run(pr.prKey)
      this.db.prepare('DELETE FROM followup_binding WHERE pr_key = ?').run(pr.prKey)
      this.db.prepare('DELETE FROM followup_pr WHERE pr_key = ?').run(pr.prKey)
    })
    return true
  }

  close(): void {
    this.db.close()
  }
}
