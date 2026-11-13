import type { SleptMailboxWake } from './slept-mailbox-wake'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { CrewInvalidation } from '../../crew/crew-changes'
import {
  RUN_PANE_KEY_MATCH_SUFFIX_SQL,
  DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL,
  REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL,
  paneKeyMatchSuffix,
  isEquivalentPaneKey
} from '../../db/pane-key-match'
import { potentiallyLiveRemoteAttachmentSql } from '../../db/federation/remote-attachment-liveness'
import { parseOrcaSessionAddress } from '../../../../../shared/orca-session-address'

/** Direct traffic gains a pane obligation when routing publishes its Run/Dispatch mailbox. */
export function mailWakeAddresses(facets: CrewInvalidation): string[] | undefined {
  return facets.mailGlobal
    ? undefined
    : [...(facets.trafficAddresses ?? [])].filter(
        (address) =>
          facets.has('topology') ||
          facets.has('records') ||
          address.startsWith('run:') ||
          address.startsWith('dispatch:')
      )
}

/** Mail candidates lead primary-key owner lookups; ownership history never leads discovery. */
export function sleepingMailOwnerMailboxes(
  db: OrchestrationDb,
  pane: string | null,
  address?: string,
  interested: (owner: string) => boolean = () => true
): string[] {
  const suffix = pane === null ? null : paneKeyMatchSuffix(pane)
  const sessionId = parseOrcaSessionAddress(address)
  const rows = db.db
    .prepare(`
    WITH candidates AS MATERIALIZED (
      SELECT DISTINCT to_handle AS mailbox FROM messages INDEXED BY idx_messages_mail_wake_candidate
      WHERE read = 0 AND delivered_at IS NULL AND pointer_enter_pending = 0
        AND delivery_contract = 'current_delivery'
        AND ((to_handle >= 'run:' AND to_handle < 'run;')
          OR (to_handle >= 'dispatch:' AND to_handle < 'dispatch;'))
    )
    -- Unary + prevents ownership-history indexes from replacing candidate-id lookups.
    SELECT candidates.mailbox, coordinator_pane_key AS owner FROM candidates
      CROSS JOIN runs ON runs.id = substr(candidates.mailbox, 5)
      WHERE candidates.mailbox >= 'run:' AND candidates.mailbox < 'run;'
        AND ${pane === null ? '(+coordinator_handle = ? OR +coordinator_orca_session_id = ?)' : `coordinator_pane_key IS NOT NULL AND +${RUN_PANE_KEY_MATCH_SUFFIX_SQL} = ?`}
    UNION ALL SELECT candidates.mailbox, assignee_pane_key AS owner FROM candidates
      CROSS JOIN dispatch_contexts ON dispatch_contexts.id = substr(candidates.mailbox, 10)
      WHERE candidates.mailbox >= 'dispatch:' AND candidates.mailbox < 'dispatch;'
        AND status IN ('pending', 'dispatched')
        AND ${pane === null ? '(+assignee_handle = ? OR +assignee_orca_session_id = ?)' : `assignee_pane_key IS NOT NULL AND +${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ?`}
    UNION ALL SELECT candidates.mailbox, pane_key AS owner FROM candidates
      CROSS JOIN remote_dispatch_attachments ON dispatch_id = substr(candidates.mailbox, 10)
      WHERE candidates.mailbox >= 'dispatch:' AND candidates.mailbox < 'dispatch;'
        AND ${potentiallyLiveRemoteAttachmentSql()}
        AND NOT EXISTS (SELECT 1 FROM dispatch_contexts WHERE id = remote_dispatch_attachments.dispatch_id)
        AND ${pane === null ? '+terminal_handle = ?' : `pane_key IS NOT NULL AND +${REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL} = ?`}
  `)
    .all(
      ...(pane === null
        ? [address ?? null, sessionId, address ?? null, sessionId, address ?? null]
        : [suffix, suffix, suffix])
    )
  return rows.flatMap((row) =>
    typeof row.mailbox === 'string' &&
    typeof row.owner === 'string' &&
    interested(row.owner) &&
    (pane === null || isEquivalentPaneKey(pane, row.owner))
      ? [row.mailbox]
      : []
  )
}

export function refreshSleepingMailOwners(
  wake: SleptMailboxWake,
  db: OrchestrationDb,
  owners: Iterable<string>,
  addresses: Iterable<string>,
  hasObligations: boolean
): Set<string> {
  const affected = new Set(owners)
  const mailboxes = new Set<string>()
  for (const pane of affected) {
    for (const mailbox of [...wake.mailboxesForPane(pane), ...wake.discover(pane)]) {
      mailboxes.add(mailbox)
    }
  }
  for (const address of addresses) {
    if (address.startsWith('run:') || address.startsWith('dispatch:')) {
      mailboxes.add(address)
    } else if (hasObligations) {
      for (const mailbox of sleepingMailOwnerMailboxes(db, null, address, (pane) =>
        wake.hasObligation(pane)
      )) {
        mailboxes.add(mailbox)
      }
    }
  }
  for (const mailbox of mailboxes) {
    for (const pane of wake.refresh(mailbox)) {
      affected.add(pane)
    }
  }
  return affected
}
