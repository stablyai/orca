import { z } from 'zod'
import type Database from '../sqlite/sync-database'
import type { Binding } from './feishu-binding'
import type { FeishuMessage } from './feishu-cli'
import type { FeishuRoutes } from './feishu-routes'
import type { BotMember } from '../../shared/bot-types'
import type { ConnectorContextItem } from '../../shared/connector-asker-contract'
import { feishuAsker } from '../../shared/bots/feishu-members'
import { feishuStoredContext } from './feishu-history-context'

export class FeishuAdmissions {
  constructor(
    private readonly db: Database.Database,
    private readonly routes: FeishuRoutes
  ) {
    const columns = this.db.prepare('PRAGMA table_info(inbox)').all()
    for (const name of ['mentioned', 'resume']) {
      if (!columns.some((c) => c.name === name)) {
        this.db.exec(`ALTER TABLE inbox ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`)
      }
    }
    if (!columns.some((c) => c.name === 'progress')) {
      this.db.exec('ALTER TABLE inbox ADD COLUMN progress INTEGER NOT NULL DEFAULT 0')
    }
    if (!columns.some((c) => c.name === 'kind')) {
      this.db.exec("ALTER TABLE inbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'")
    }
    if (!columns.some((c) => c.name === 'stored_path')) {
      this.db.exec('ALTER TABLE inbox ADD COLUMN stored_path TEXT')
    }
    if (!columns.some((c) => c.name === 'context')) {
      this.db.exec('ALTER TABLE inbox ADD COLUMN context TEXT')
    }
    if (!columns.some((c) => c.name === 'sender')) {
      this.db.exec(`ALTER TABLE inbox ADD COLUMN sender TEXT;
        UPDATE inbox SET sender=(SELECT owner FROM bindings WHERE bindings.account=inbox.account)`)
    }
  }
  accept(
    b: Binding,
    m: FeishuMessage,
    context: ConnectorContextItem[] = [],
    members: readonly BotMember[] = [],
    control: { mentioned?: boolean; resume?: boolean } = {}
  ): void {
    if (
      (b.profile === null &&
        (m.sender_id !== b.owner || m.chat_type !== 'p2p' || m.chat_id !== b.chat)) ||
      !feishuAsker(b, members, m.sender_id) ||
      m.sender_type === 'bot' ||
      (m.chat_id !== b.chat && this.routes.message(b.account, m.message_id)?.chat !== m.chat_id) ||
      b.pairedAt === null ||
      Number(m.create_time) <= b.pairedAt
    ) {
      return
    }
    this.db
      .prepare(
        'INSERT OR IGNORE INTO inbox(account,mid,event,body,kind,context,sender,mentioned,resume) VALUES(?,?,?,?,?,?,?,?,?)'
      )
      .run(
        b.account,
        m.message_id,
        m.event_id,
        m.content,
        m.message_type,
        JSON.stringify(context),
        m.sender_id,
        Number(Boolean(control.mentioned)),
        Number(Boolean(control.resume))
      )
  }
  next(account: string) {
    const row = this.db
      .prepare(
        'SELECT mid,body,kind,stored_path AS path,context,sender,mentioned,resume FROM inbox WHERE account=? AND body IS NOT NULL AND review=0 ORDER BY rowid LIMIT 1'
      )
      .get(account)
    return (
      row &&
      z
        .object({
          mid: z.string(),
          mentioned: z.number().transform(Boolean),
          resume: z.number().transform(Boolean),
          sender: z.string().nullable(),
          body: z.string(),
          kind: z.enum(['text', 'image', 'file', 'post']),
          context: feishuStoredContext,
          path: z.string().nullable()
        })
        .parse(row)
    )
  }

  sender(account: string, mid: string): string | null {
    const row = this.db
      .prepare('SELECT sender FROM inbox WHERE account=? AND mid=?')
      .get(account, mid)
    return typeof row?.sender === 'string' ? row.sender : null
  }
  laneSender(account: string, external: string): string | null {
    const row = this.db
      .prepare(`SELECT i.sender FROM inbox i JOIN feishu_routes r ON r.account=i.account AND r.mid=i.mid
      WHERE r.account=? AND r.external=? AND i.sender IS NOT NULL ORDER BY i.rowid LIMIT 1`)
      .get(account, external)
    return typeof row?.sender === 'string' ? row.sender : null
  }
}
