import type Database from '../../../../sqlite/sync-database'

export type MailSourceMutation = {
  id: string
  previousMailbox: string | null
  mailbox: string | null
  state: string | null
  forced: boolean
  previousMailboxes: readonly string[]
}
const columns = [
  'run_id',
  'to_handle',
  'type',
  'read',
  'delivered_at',
  'pointer_enter_pending',
  'delivery_contract',
  'ordering_origin'
]
const contentChanged = ['subject', 'body', 'payload', 'from_handle']
  .map((column) => `OLD.${column} IS NOT NEW.${column}`)
  .join(' OR ')
const snapshot = (prefix: string) =>
  `json_array(${columns.map((column) => `${prefix}.${column}`).join(',')})`

/** Connection-local transactional nominations: a rollback rolls these rows back too. */
export class MailSourceMutations {
  private listener: ((mutations: readonly MailSourceMutation[]) => void) | undefined
  private scheduled = false
  private disposed = false
  private notifyRetry: ((mailboxes: readonly string[]) => void) | undefined
  private readonly wakeMailboxes = new Set<string>()
  private readonly pending = new Map<string, MailSourceMutation>()
  constructor(private readonly db: Database.Database) {
    db.function('nominate_mail_source', { varargs: true }, (...mailboxes) => {
      for (const mailbox of mailboxes) {
        if (typeof mailbox === 'string') {
          this.wakeMailboxes.add(mailbox)
        }
      }
      this.schedule()
      return 0
    })
    db.exec(`CREATE TEMP TABLE mail_source_changes (
      id TEXT PRIMARY KEY, previous_mailbox TEXT, before_json TEXT, forced INTEGER NOT NULL DEFAULT 0);
      CREATE TEMP TRIGGER nominate_mail_insert AFTER INSERT ON main.messages BEGIN
        INSERT OR IGNORE INTO mail_source_changes(id) VALUES (NEW.id);
        SELECT nominate_mail_source(NEW.to_handle); END;
      CREATE TEMP TRIGGER nominate_mail_update BEFORE UPDATE ON main.messages
      WHEN ${snapshot('OLD')} IS NOT ${snapshot('NEW')} OR ${contentChanged} BEGIN
        INSERT INTO mail_source_changes(id, previous_mailbox, before_json, forced)
          VALUES (OLD.id, OLD.to_handle, ${snapshot('OLD')}, ${contentChanged})
          ON CONFLICT(id) DO UPDATE SET forced = max(forced, excluded.forced);
        SELECT nominate_mail_source(OLD.to_handle, NEW.to_handle); END;
      CREATE TEMP TRIGGER nominate_mail_delete BEFORE DELETE ON main.messages BEGIN
        INSERT OR IGNORE INTO mail_source_changes(id, previous_mailbox, before_json)
          VALUES (OLD.id, OLD.to_handle, ${snapshot('OLD')});
        SELECT nominate_mail_source(OLD.to_handle); END;`)
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = event === 'DELETE' ? 'OLD' : 'NEW'
      db.exec(`CREATE TEMP TRIGGER nominate_mail_delivery_${event.toLowerCase()}
        AFTER ${event} ON main.deliveries BEGIN
        INSERT INTO mail_source_changes(id, previous_mailbox, before_json, forced)
          SELECT value, ${row}.mailbox_handle, NULL, 1 FROM json_each(${row}.message_ids) WHERE true
          ON CONFLICT(id) DO UPDATE SET forced = 1;
        SELECT nominate_mail_source(${row}.mailbox_handle); END;`)
    }
  }
  subscribe(
    listener: (mutations: readonly MailSourceMutation[]) => void,
    retry?: (mailboxes: readonly string[]) => void
  ): () => void {
    this.listener = listener
    this.notifyRetry = retry
    this.schedule()
    return () => {
      if (this.listener === listener) {
        this.listener = undefined
        this.notifyRetry = undefined
      }
    }
  }
  dispose(): void {
    this.disposed = true
    this.listener = undefined
    this.notifyRetry = undefined
    this.wakeMailboxes.clear()
    this.pending.clear()
  }
  private schedule(): void {
    if (this.scheduled || this.disposed) {
      return
    }
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.flushCommitted()
    })
  }
  flushCommitted(): void {
    if (this.disposed || !this.listener) {
      return
    }
    try {
      if (this.db.isTransaction) {
        this.retryLater()
        return
      }
      const changes = this.db.prepare('SELECT * FROM mail_source_changes').all()
      for (const change of changes) {
        if (typeof change.id !== 'string') {
          continue
        }
        const current = this.db
          .prepare(
            `SELECT to_handle, ${snapshot('messages')} AS snapshot FROM messages WHERE id = ?`
          )
          .get(change.id)
        if (change.forced || (current?.snapshot ?? null) !== change.before_json) {
          const previous = this.pending.get(change.id)
          this.pending.set(change.id, {
            id: change.id,
            previousMailbox:
              typeof change.previous_mailbox === 'string' ? change.previous_mailbox : null,
            mailbox: typeof current?.to_handle === 'string' ? current.to_handle : null,
            state: typeof current?.snapshot === 'string' ? current.snapshot : null,
            previousMailboxes: [
              ...new Set(
                [
                  ...(previous?.previousMailboxes ?? []),
                  previous?.mailbox,
                  change.previous_mailbox
                ].filter((value): value is string => typeof value === 'string')
              )
            ],
            forced: Boolean(change.forced)
          })
        }
      }
      this.db.exec('DELETE FROM mail_source_changes')
      this.wakeMailboxes.clear()
      const batch = [...this.pending.values()]
      if (batch.length) {
        this.listener(batch)
        for (const item of batch) {
          if (this.pending.get(item.id) === item) {
            this.pending.delete(item.id)
          }
        }
      }
    } catch (error) {
      console.warn('[orchestration] unfinished exact mail notification', error)
      this.retryLater()
    }
  }
  private retryLater(): void {
    if (this.disposed) {
      return
    }
    for (const item of this.pending.values()) {
      for (const mailbox of [...item.previousMailboxes, item.mailbox]) {
        if (mailbox) {
          this.wakeMailboxes.add(mailbox)
        }
      }
    }
    this.notifyRetry?.([...this.wakeMailboxes])
  }
}
