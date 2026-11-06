import type { ClaudePaneAccountSnapshot } from '../../shared/managed-account-types'
import { claudeAccountShortLabel } from './claude-account-short-label'
import {
  claudeBillingAccountId,
  type ClaudePaneAccountRecord
} from './claude-pane-account-registry'

/** Panes whose billed account is still managed, plus a session count for every account. */
export function claudeListedPaneAccounts(
  accounts: readonly { id: string; email: string }[],
  records: readonly ClaudePaneAccountRecord[]
): {
  paneAccounts: ClaudePaneAccountSnapshot[]
  assignedSessions: { accountId: string; count: number }[]
} {
  const emails = accounts.map((account) => account.email)
  const paneAccounts: ClaudePaneAccountSnapshot[] = []
  for (const record of records) {
    const accountId = claudeBillingAccountId(record)
    const account = accounts.find((candidate) => candidate.id === accountId)
    if (!account) {
      continue
    }
    paneAccounts.push({
      ptyId: record.ptyId,
      paneKey: record.paneKey,
      accountId,
      email: account.email,
      label: claudeAccountShortLabel(account.email, emails)
    })
  }
  return {
    paneAccounts,
    assignedSessions: accounts.map((account) => ({
      accountId: account.id,
      count: paneAccounts.filter((pane) => pane.accountId === account.id).length
    }))
  }
}
