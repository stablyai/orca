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
          ((facets.has('topology') || facets.has('records')) && !facets.mailboxOwners?.size) ||
          address.startsWith('run:') ||
          address.startsWith('dispatch:')
      )
}

/** Current authority ranges lead exact inbox seeks, including old Runs still bound to this owner. */
export function sleepingMailOwnerMailboxes(
  db: OrchestrationDb,
  pane: string | null,
  address?: string,
  interested: (owner: string) => boolean = () => true,
  visited = new Set<string>()
): string[] {
  const sessionId = parseOrcaSessionAddress(address)
  const suffix = pane === null ? null : paneKeyMatchSuffix(pane)
  const branches: {
    table: string
    index: string
    key: string
    value: string
    id: string
    owner: string
    live: string
  }[] = []
  const add = (
    table: string,
    index: string,
    key: string,
    value: string | null | undefined,
    id: string,
    owner: string,
    live = ''
  ) => {
    if (value != null) {
      branches.push({ table, index, key, value, id, owner, live })
    }
  }
  const localLive = " AND status IN ('pending', 'dispatched')"
  const remoteLive = ` AND ${potentiallyLiveRemoteAttachmentSql()}
    AND NOT EXISTS (SELECT 1 FROM dispatch_contexts WHERE id = remote_dispatch_attachments.dispatch_id)`
  if (pane !== null) {
    add(
      'runs',
      'idx_runs_coordinator_pane_leaf',
      RUN_PANE_KEY_MATCH_SUFFIX_SQL,
      suffix,
      'id',
      'coordinator_pane_key',
      ' AND coordinator_pane_key IS NOT NULL'
    )
    add(
      'dispatch_contexts',
      'idx_dispatch_assignee_pane_leaf',
      DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL,
      suffix,
      'id',
      'assignee_pane_key',
      ` AND assignee_pane_key IS NOT NULL${localLive}`
    )
    add(
      'remote_dispatch_attachments',
      'idx_remote_dispatch_attachments_active_pane_suffix',
      REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL,
      suffix,
      'dispatch_id',
      'pane_key',
      ` AND pane_key IS NOT NULL${remoteLive}`
    )
  } else {
    add(
      'runs',
      'idx_runs_coordinator_orca_session_id',
      'coordinator_orca_session_id',
      sessionId,
      'id',
      'coordinator_pane_key',
      ' AND coordinator_orca_session_id_generation = consumer_generation'
    )
    add(
      'dispatch_contexts',
      'idx_dispatch_assignee_orca_session_id',
      'assignee_orca_session_id',
      sessionId,
      'id',
      'assignee_pane_key',
      localLive
    )
    add(
      'runs',
      'idx_runs_current_coordinator_handle',
      'coordinator_handle',
      address,
      'id',
      'coordinator_pane_key'
    )
    add(
      'dispatch_contexts',
      'idx_dispatch_assignee_handle',
      'assignee_handle',
      address,
      'id',
      'assignee_pane_key',
      localLive
    )
    add(
      'remote_dispatch_attachments',
      'idx_crew_remote_handle',
      'terminal_handle',
      address,
      'dispatch_id',
      'pane_key',
      remoteLive
    )
  }
  const found: string[] = []
  for (const branch of branches) {
    const prefix = branch.table === 'runs' ? 'run:' : 'dispatch:'
    const rows = db.db
      .prepare(`SELECT '${prefix}' || ${branch.id} AS mailbox, ${branch.owner} AS owner
      FROM ${branch.table} INDEXED BY ${branch.index} WHERE ${branch.key} = ?${branch.live}`)
      .all(branch.value)
    for (const row of rows) {
      if (
        typeof row.mailbox !== 'string' ||
        typeof row.owner !== 'string' ||
        visited.has(row.mailbox) ||
        !interested(row.owner) ||
        (pane !== null && !isEquivalentPaneKey(pane, row.owner))
      ) {
        continue
      }
      visited.add(row.mailbox)
      if (
        db.db
          .prepare(`SELECT EXISTS (
        SELECT 1 FROM messages INDEXED BY idx_messages_mail_wake_candidate
        WHERE to_handle = ? AND read = 0 AND delivered_at IS NULL AND pointer_enter_pending = 0
          AND delivery_contract = 'current_delivery'
      ) AS eligible`)
          .get(row.mailbox)?.eligible === 1
      ) {
        found.push(row.mailbox)
      }
    }
  }
  return found
}

export function refreshSleepingMailOwners(
  wake: SleptMailboxWake,
  db: OrchestrationDb,
  owners: Iterable<string>,
  addresses: Iterable<string>,
  hasObligations: boolean
): Set<string> {
  const affected = new Set(owners)
  const changedAddresses = new Set(addresses)
  const mailboxes = new Set(
    [...changedAddresses].filter(
      (address) => address.startsWith('run:') || address.startsWith('dispatch:')
    )
  )
  for (const pane of affected) {
    for (const mailbox of wake.mailboxesForPane(pane)) {
      mailboxes.add(mailbox)
    }
  }
  const visited = new Set(mailboxes)
  for (const pane of affected) {
    for (const mailbox of wake.discover(pane, visited)) {
      mailboxes.add(mailbox)
    }
  }
  if (hasObligations) {
    for (const address of changedAddresses) {
      if (!mailboxes.has(address)) {
        for (const mailbox of sleepingMailOwnerMailboxes(
          db,
          null,
          address,
          (pane) => wake.hasObligation(pane),
          visited
        )) {
          mailboxes.add(mailbox)
        }
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
