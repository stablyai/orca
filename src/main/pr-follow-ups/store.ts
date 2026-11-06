import Database from '../sqlite/sync-database'
import type { FollowUpAction, FollowUpPr } from '../../shared/pr-follow-ups/contracts'

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
    db.exec(`
      CREATE INDEX IF NOT EXISTS followup_action_pending ON followup_action(pr_key) WHERE (json_extract(payload, '$.status') IN ('claimed', 'unconfirmed') AND json_extract(payload, '$.recoveryFinalizedAt') IS NULL OR (json_extract(payload, '$.status') = 'accepted' AND json_extract(payload, '$.sessionEndedAt') IS NULL));
      CREATE INDEX IF NOT EXISTS followup_action_session ON followup_action(json_extract(payload, '$.sessionId'));
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

  actionsForIdentity(identity: string): FollowUpAction[] {
    return this.db
      .prepare(
        "SELECT payload FROM followup_action WHERE json_extract(payload, '$.sessionId') = ? OR json_extract(payload, '$.terminalPtyId') = ?"
      )
      .all(identity, identity)
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

  workingOverlap(prKey: string, from: number, to: number): boolean {
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM followup_action WHERE pr_key = ? AND json_extract(payload, '$.status') = 'accepted'
      AND EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(payload, '$.workingIntervals'), json_array(json_object('start', COALESCE(json_extract(payload, '$.sessionStartedAt'), json_extract(payload, '$.attemptStartedAt')), 'end', json_extract(payload, '$.sessionEndedAt')))))
      WHERE json_extract(value, '$.start') <= ? AND (json_extract(value, '$.end') IS NULL OR json_extract(value, '$.end') >= ?)) LIMIT 1`)
        .get(prKey, to, from)
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
