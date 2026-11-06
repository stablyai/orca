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
    return this.db
      .prepare('SELECT payload FROM followup_action WHERE pr_key = ?')
      .all(prKey)
      .map((row) => JSON.parse(String(row.payload)))
  }

  saveAction(action: FollowUpAction): void {
    this.db
      .prepare(
        'INSERT INTO followup_action VALUES (?, ?, ?) ON CONFLICT(action_key) DO UPDATE SET payload = excluded.payload'
      )
      .run(action.actionKey, action.prKey, JSON.stringify(action))
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
    const pending = this.actions(pr.prKey).some(
      (action) =>
        action.status === 'claimed' ||
        action.status === 'unconfirmed' ||
        (action.status === 'accepted' && action.sessionEndedAt === undefined)
    )
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
