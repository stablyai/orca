import type Database from '../sqlite/sync-database'
export class FeishuReplyCheckpoints {
  constructor(private readonly db: Database.Database) {}
  replyState(account: string, mid: string) {
    const row = this.db
      .prepare('SELECT first_post,review,reply_done FROM inbox WHERE account=? AND mid=?')
      .get(account, mid)
    return (
      row && {
        firstPost: typeof row.first_post === 'number' ? row.first_post : null,
        review: !!row.review,
        done: !!row.reply_done
      }
    )
  }
  /** Keep the local outcome even if the independent native journal cannot settle yet. */
  finishReply(account: string, mid: string, review: boolean): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const changed =
        review &&
        Boolean(
          this.db
            .prepare('UPDATE inbox SET review=1 WHERE account=? AND mid=? AND review=0')
            .run(account, mid).changes
        )
      this.db.prepare('UPDATE inbox SET reply_done=1 WHERE account=? AND mid=?').run(account, mid)
      this.db
        .prepare('DELETE FROM reply_files WHERE account=? AND mid=? AND bytes IS NOT NULL')
        .run(account, mid)
      this.db.exec('COMMIT')
      return changed
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  /** A reply whose outcome was lost must only be retried within Feishu's one-hour UUID window. */
  postWindowStart(account: string, mid: string, now: number): number | null {
    this.db
      .prepare(
        'UPDATE inbox SET first_post=? WHERE account=? AND mid=? AND first_post IS NULL AND review=0 AND reply_done=0'
      )
      .run(now, account, mid)
    const row = this.replyState(account, mid)
    return row && !row.review && !row.done ? row.firstPost : null
  }
}
