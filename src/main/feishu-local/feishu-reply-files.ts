import { createHash } from 'node:crypto'
import { z } from 'zod'
import type Database from '../sqlite/sync-database'

export class FeishuReplyFiles {
  constructor(private readonly db: Database.Database) {
    if (
      !this.db
        .prepare('PRAGMA table_info(reply_files)')
        .all()
        .some((c) => c.name === 'digest')
    ) {
      const digest = this.db
        .prepare('PRAGMA table_info(reply_files)')
        .all()
        .some((c) => c.name === 'sha256')
        ? 'sha256'
        : 'NULL'
      this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE reply_files RENAME TO reply_files_old;
        CREATE TABLE reply_files(account TEXT NOT NULL,mid TEXT NOT NULL,name TEXT NOT NULL,bytes BLOB,file_key TEXT,posted INTEGER NOT NULL DEFAULT 0,digest TEXT,part TEXT NOT NULL,PRIMARY KEY(account,mid,name),FOREIGN KEY(account,mid) REFERENCES inbox(account,mid) ON DELETE CASCADE);
        INSERT INTO reply_files(account,mid,name,bytes,file_key,posted,digest,part) SELECT account,mid,name,bytes,file_key,posted,${digest},'file' FROM reply_files_old;
        DROP TABLE reply_files_old;
        COMMIT;`)
    }
  }
  stageFile(account: string, mid: string, name: string, bytes: Uint8Array): void {
    const digest = createHash('sha256').update(bytes).digest('hex')
    const row = this.db
      .prepare('SELECT digest,bytes FROM reply_files WHERE account=? AND mid=? AND name=?')
      .get(account, mid, name)
    if (
      row &&
      (row.digest === digest ||
        (row.bytes instanceof Uint8Array && Buffer.from(row.bytes).equals(bytes)))
    ) {
      return
    }
    if (row) {
      throw new Error('A different file already uses this name in the reply')
    }
    const count = this.db
      .prepare('SELECT count(*) AS count FROM reply_files WHERE account=? AND mid=?')
      .get(account, mid)
    if (Number(count?.count) >= 10) {
      throw new Error('A Feishu reply takes up to 10 files')
    }
    const inserted = this.db
      .prepare(
        'INSERT INTO reply_files(account,mid,name,bytes,digest,part) SELECT account,mid,?,?,?,? FROM inbox WHERE account=? AND mid=? AND review=0 AND reply_done=0'
      )
      .run(
        name,
        bytes,
        digest,
        `file:${createHash('sha256').update(name).digest('hex')}`,
        account,
        mid
      )
    if (!inserted.changes) {
      throw new Error('This Feishu delivery cannot receive another file')
    }
  }
  artifacts(account: string, mid: string) {
    return this.db
      .prepare(
        'SELECT name,bytes,file_key AS key,posted,part FROM reply_files WHERE account=? AND mid=? ORDER BY rowid'
      )
      .all(account, mid)
      .map((row) =>
        z
          .object({
            part: z.union([z.literal('file'), z.templateLiteral(['file:', z.string()])]),
            name: z.string(),
            bytes: z.instanceof(Uint8Array).nullable(),
            key: z.string().nullable(),
            posted: z.number()
          })
          .parse(row)
      )
  }
  uploaded(account: string, mid: string, name: string, key: string): void {
    this.db
      .prepare('UPDATE reply_files SET file_key=?,bytes=NULL WHERE account=? AND mid=? AND name=?')
      .run(key, account, mid, name)
  }
  filePosted(account: string, mid: string, name: string): void {
    this.db
      .prepare('UPDATE reply_files SET posted=1 WHERE account=? AND mid=? AND name=?')
      .run(account, mid, name)
  }
}
