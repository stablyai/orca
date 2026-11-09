// A chat's verified publication of its checkout, kept until the workspace follows it or the
// checkout moves on. Saved with the action, so a failed attempt is retried on the PR's next read.

import type Database from '../../sqlite/sync-database'
import { numberColumn, textColumn } from './pr-watch-sqlite-columns'
import type { ParsedPRKey } from './pr-watch-types'

/** What the verification saw: the checkout's branch then, and the push's `To` URL when it had one. */
export type PRBranchAdoptionIntent = { checkoutBranch: string; remoteUrl: string | null }

export type PRBranchAdoption = PRBranchAdoptionIntent & {
  chatId: string
  pr: ParsedPRKey
  createdAt: number
}

/** A later publication by the same chat replaces the earlier one. */
export function insertPRBranchAdoption(db: Database.Database, adoption: PRBranchAdoption): void {
  db.prepare(
    `INSERT OR REPLACE INTO pr_branch_adoptions
      (chat_id, forge_host, owner, repo, number, checkout_branch, remote_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    adoption.chatId,
    adoption.pr.host.toLowerCase(),
    adoption.pr.owner.toLowerCase(),
    adoption.pr.repo.toLowerCase(),
    adoption.pr.number,
    adoption.checkoutBranch,
    adoption.remoteUrl,
    adoption.createdAt
  )
}

export function readPRBranchAdoptions(
  db: Database.Database,
  pr: ParsedPRKey,
  after: number
): PRBranchAdoption[] {
  return db
    .prepare(
      `SELECT chat_id, checkout_branch, remote_url, created_at FROM pr_branch_adoptions
        WHERE forge_host = ? AND owner = ? AND repo = ? AND number = ? AND created_at > ?`
    )
    .all(pr.host.toLowerCase(), pr.owner.toLowerCase(), pr.repo.toLowerCase(), pr.number, after)
    .flatMap((row) => {
      const chatId = textColumn(row, 'chat_id')
      const checkoutBranch = textColumn(row, 'checkout_branch')
      const createdAt = numberColumn(row, 'created_at')
      return chatId === null || checkoutBranch === null || createdAt === null
        ? []
        : [{ chatId, pr, checkoutBranch, remoteUrl: textColumn(row, 'remote_url'), createdAt }]
    })
}

/** Ends this attempt's intent only; a newer publication saved meanwhile stays. */
export function deletePRBranchAdoption(db: Database.Database, adoption: PRBranchAdoption): void {
  db.prepare(
    `DELETE FROM pr_branch_adoptions
      WHERE chat_id = ? AND forge_host = ? AND owner = ? AND repo = ? AND number = ? AND created_at = ?`
  ).run(
    adoption.chatId,
    adoption.pr.host.toLowerCase(),
    adoption.pr.owner.toLowerCase(),
    adoption.pr.repo.toLowerCase(),
    adoption.pr.number,
    adoption.createdAt
  )
}

/** Publications at or before `cutoff` are never offered again. */
export function deleteExpiredPRBranchAdoptions(db: Database.Database, cutoff: number): void {
  db.prepare('DELETE FROM pr_branch_adoptions WHERE created_at <= ?').run(cutoff)
}
