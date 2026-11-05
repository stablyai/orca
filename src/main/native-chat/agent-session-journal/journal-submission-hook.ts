import { finishJournalSteps } from './journal-reconstruction-steps'
import type { JournalPersistencePlan } from './journal-persistence-plan'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalRow } from './journal-row-schema'

/** Claim attachments atomically; required rejects missing uploads except references retained from previous. */
export type JournalAttachmentClaim = (
  db: JournalPersistencePlan,
  body: AgentJournalMessageItem,
  required: boolean,
  previous?: AgentJournalMessageItem,
  goalId?: string
) => Promise<(() => void) | void>

import {
  composeJournalOperationReceipts,
  settleJournalCommitAsync,
  type JournalOperationReceipt
} from './journal-row-writer'

/** Committed accepted inputs revoke any live permission to retract their protection. */
export function journalAttachmentClaimsReceipt(
  claim: JournalAttachmentClaim,
  bodies: readonly AgentJournalMessageItem[],
  receipt?: JournalOperationReceipt
): JournalOperationReceipt {
  const commits: (() => void)[] = []
  const claims: JournalOperationReceipt = {
    write: async (db) => {
      let work = 0
      for (const body of bodies) {
        const commit = await claim(db, body, false)
        if (commit) {
          commits.push(commit)
        }
        if (++work === 128) {
          work = 0
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }
    },
    committed: () => settleJournalCommitAsync(commits)
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
  return finishJournalSteps(journalInputClaimsReceiptSteps(claim, isLiveGoal, rows, receipt))
}

export function* journalInputClaimsReceiptSteps(
  claim: JournalAttachmentClaim,
  isLiveGoal: (id: string) => boolean,
  rows: readonly JournalRow[],
  receipt?: JournalOperationReceipt
): Generator<void, JournalOperationReceipt | undefined> {
  const bodies: AgentJournalMessageItem[] = []
  for (const row of rows) {
    for (const item of row.kind === 'lifecycle-batch' ? row.mutations : [row]) {
      yield
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
  claim: (db: JournalPersistencePlan) => Promise<(() => void) | void>,
  afterCommit: () => void = () => {}
): JournalOperationReceipt {
  let committed: (() => void) | void
  return {
    write: async (db) => {
      committed = await claim(db)
    },
    committed: () => {
      committed?.()
      afterCommit()
    }
  }
}
