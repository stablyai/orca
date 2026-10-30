import type Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { JournalRow } from './journal-row-schema'

/** Claim attachments atomically; required rejects missing uploads except references retained from previous. */
export type JournalAttachmentClaim = (
  db: Database.Database,
  body: AgentJournalMessageItem,
  required: boolean,
  previous?: AgentJournalMessageItem,
  goalId?: string
) => (() => void) | void

import { composeJournalOperationReceipts, type JournalOperationReceipt } from './journal-row-writer'

/** Committed accepted inputs revoke any live permission to retract their protection. */
export function journalAttachmentClaimsReceipt(
  claim: JournalAttachmentClaim,
  bodies: readonly AgentJournalMessageItem[],
  receipt?: JournalOperationReceipt
): JournalOperationReceipt {
  const commits: (() => void)[] = []
  const claims: JournalOperationReceipt = {
    write: (db) => {
      for (const body of bodies) {
        const commit = claim(db, body, false)
        if (commit) {
          commits.push(commit)
        }
      }
    },
    committed: () => commits.forEach((commit) => commit())
  }
  return receipt ? composeJournalOperationReceipts(claims, receipt) : claims
}

/** Select actual independent input after building once, before choosing transaction durability. */
export function journalInputClaimsReceipt(
  claim: JournalAttachmentClaim,
  isLiveGoal: (id: string) => boolean,
  rows: readonly JournalRow[],
  receipt?: JournalOperationReceipt
): JournalOperationReceipt | undefined {
  const bodies: AgentJournalMessageItem[] = []
  for (const row of rows) {
    for (const item of row.kind === 'lifecycle-batch' ? row.mutations : [row]) {
      if (
        item.kind === 'item' &&
        item.body.kind === 'message' &&
        item.body.role === 'user' &&
        !isLiveGoal(item.itemId)
      ) {
        bodies.push(item.body)
      }
    }
  }
  return bodies.length ? journalAttachmentClaimsReceipt(claim, bodies, receipt) : receipt
}

export function journalAttachmentClaimReceipt(
  claim: (db: Database.Database) => (() => void) | void,
  afterCommit: () => void = () => {}
): JournalOperationReceipt {
  let committed: (() => void) | void
  return {
    write: (db) => {
      committed = claim(db)
    },
    committed: () => {
      committed?.()
      afterCommit()
    }
  }
}
