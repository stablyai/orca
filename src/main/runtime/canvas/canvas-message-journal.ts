import { createHash } from 'node:crypto'
import type { OrchestrationDb } from '../orchestration/db'
import { canvasMessageSchema, type CanvasMessage } from '../../../shared/canvas-messaging'

export class CanvasMessageJournal {
  constructor(private readonly db: OrchestrationDb) {
    db.db.exec(`CREATE TABLE IF NOT EXISTS canvas_mail (
      id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      canvas_id TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
      metadata TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_canvas_mail_history ON canvas_mail(canvas_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_canvas_mail_pending ON canvas_mail(state, created_at);`)
    for (const message of this.rows("WHERE c.state = 'sending'")) {
      if (message.state === 'sending') {
        this.update(
          message,
          'unverifiable',
          'Orca restarted during delivery. Inspect the recipient before sending again.'
        )
      }
    }
  }

  get(id: string): CanvasMessage | undefined {
    return this.decode(
      this.db.db
        .prepare(
          'SELECT c.*, m.body FROM canvas_mail c JOIN messages m ON m.id = c.id WHERE c.id = ?'
        )
        .get(id)
    )
  }

  history(canvasId: string): CanvasMessage[] {
    return this.rows(
      'WHERE c.canvas_id = ? ORDER BY c.created_at DESC LIMIT 500',
      canvasId
    ).toReversed()
  }

  pending(): CanvasMessage[] {
    return this.rows("WHERE c.state = 'queued' ORDER BY c.created_at LIMIT 1000")
  }

  count(canvasId: string, since: number): number {
    return (
      this.db.db
        .prepare(
          'SELECT COUNT(*) AS count FROM canvas_mail WHERE canvas_id = ? AND created_at >= ?'
        )
        .get(canvasId, since) as { count: number }
    ).count
  }

  insert(message: CanvasMessage): CanvasMessage {
    this.db.db.exec('SAVEPOINT canvas_mail_insert')
    try {
      const scope = createHash('sha256').update(message.canvasId).digest('hex')
      this.db.insertMessage({
        id: message.id,
        from: `canvas:${scope}:${message.source}`,
        to: `canvas:${scope}:${message.target}`,
        subject: `${message.sourceName} → ${message.targetName}`,
        body: message.body,
        threadId: message.threadId,
        deliveryContract: 'audit_only'
      })
      const { body: _body, ...metadata } = message
      this.db.db
        .prepare(
          'INSERT INTO canvas_mail (id, canvas_id, state, created_at, metadata) VALUES (?, ?, ?, ?, ?)'
        )
        .run(
          message.id,
          message.canvasId,
          message.state,
          message.createdAt,
          JSON.stringify(metadata)
        )
      this.db.db.exec('RELEASE canvas_mail_insert')
      return message
    } catch (error) {
      this.db.db.exec('ROLLBACK TO canvas_mail_insert; RELEASE canvas_mail_insert')
      throw error
    }
  }

  update(message: CanvasMessage, state: CanvasMessage['state'], detail = ''): void {
    if (message.state === state && message.detail === detail) {
      return
    }
    const { body: _body, ...metadata } = { ...message, state, detail }
    this.db.db
      .prepare('UPDATE canvas_mail SET state = ?, metadata = ? WHERE id = ?')
      .run(state, JSON.stringify(metadata), message.id)
  }

  private rows(suffix: string, ...params: string[]): CanvasMessage[] {
    return this.db.db
      .prepare(`SELECT c.*, m.body FROM canvas_mail c JOIN messages m ON m.id = c.id ${suffix}`)
      .all(...params)
      .flatMap((row) => {
        const message = this.decode(row)
        return message ? [message] : []
      })
  }

  private decode(row: unknown): CanvasMessage | undefined {
    if (!row) {
      return undefined
    }
    const value = row as { metadata: string; body: string }
    return canvasMessageSchema.parse({ ...JSON.parse(value.metadata), body: value.body })
  }
}
