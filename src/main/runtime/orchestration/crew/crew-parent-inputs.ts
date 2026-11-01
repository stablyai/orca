import { z } from 'zod'
import { readCrewAssignmentIds } from './crew-query'
import type { OrchestrationDb } from '../db'
import { currentRunCoordinatorOrcaSessionIdSql } from '../db/runs/run-coordinator-orca-session'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { potentiallyLiveRemoteAttachmentSql } from '../db/federation/remote-attachment-liveness'
import {
  DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL,
  REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL,
  paneKeyMatchSuffix
} from '../db/pane-key-match'

const nullable = z.string().nullable()
const claim = z.object({
  id: z.string(),
  task: z.string(),
  run: z.string(),
  runHome: z.string(),
  handle: nullable,
  pane: nullable,
  session: nullable,
  process: nullable,
  host: nullable,
  endpoint: nullable,
  creator: nullable,
  creatorHandle: nullable,
  creatorPane: nullable,
  creatorSession: nullable,
  retry: nullable,
  home: nullable,
  coordinator: nullable,
  coordinatorPane: nullable,
  coordinatorSession: nullable
})
export type CrewParentClaim = z.infer<typeof claim> & {
  family: 'local' | 'remote'
  remoteRoute?: { ordinal: number; active: boolean; stopping: boolean }
}
const resource = z.object({
  id: z.string(),
  origin: z.string(),
  owner: z.string(),
  prior: z.string(),
  handle: z.string(),
  pane: nullable,
  process: nullable,
  host: nullable,
  endpoint: nullable,
  endpointProcess: nullable,
  ownership: z.string()
})
export type CrewParentResource = z.infer<typeof resource>

const localColumns = `d.id, d.task_id AS task, d.run_id AS run, r.home_database AS runHome, d.assignee_handle AS handle,
 d.assignee_pane_key AS pane, d.assignee_orca_session_id AS session,
 d.process_incarnation AS process, d.host_scope AS host, w.runtime_epoch AS endpoint,
 d.creator_dispatch_id AS creator, d.creator_handle AS creatorHandle,
 d.creator_pane_key AS creatorPane, d.creator_orca_session_id AS creatorSession,
 d.retry_of_dispatch_id AS retry, NULL AS home, r.coordinator_handle AS coordinator,
 r.coordinator_pane_key AS coordinatorPane,
 ${currentRunCoordinatorOrcaSessionIdSql('r')} AS coordinatorSession`

export function readCrewParentInputs(db: OrchestrationDb, addresses: string[], panes: string[]) {
  const handles = JSON.stringify(addresses.filter((value) => value.startsWith('term_')))
  const sessions = JSON.stringify(
    addresses
      .filter((value) => value.startsWith('orca_session_id:'))
      .map((value) => value.slice(16))
  )
  const ids = JSON.stringify(
    addresses.filter((value) => value.startsWith('dispatch:')).map((value) => value.slice(9))
  )
  const paneKeys = JSON.stringify(panes)
  const leaves = JSON.stringify(panes.filter((pane) => parsePaneKey(pane)).map(paneKeyMatchSuffix))
  const local = claim
    .array()
    .parse(
      db.db
        .prepare(`SELECT ${localColumns}
    FROM dispatch_contexts d JOIN runs r ON r.id = d.run_id
    LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
    WHERE d.rowid IN (
      SELECT rowid FROM dispatch_contexts WHERE assignee_handle IN (SELECT value FROM json_each(?))
      UNION SELECT rowid FROM dispatch_contexts WHERE assignee_orca_session_id IN (SELECT value FROM json_each(?))
      UNION SELECT rowid FROM dispatch_contexts WHERE assignee_pane_key IN (SELECT value FROM json_each(?))
      UNION SELECT rowid FROM dispatch_contexts WHERE assignee_pane_key IS NOT NULL AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} IN (SELECT value FROM json_each(?))
      UNION SELECT rowid FROM dispatch_contexts WHERE id IN (SELECT value FROM json_each(?)))
    ORDER BY d.id`)
        .all(handles, sessions, paneKeys, leaves, ids)
    )
    .map((row): CrewParentClaim => ({ ...row, family: 'local' }))
  const remote = claim
    .extend({ ordinal: z.number(), active: z.number(), stopping: z.number() })
    .array()
    .parse(
      db.db
        .prepare(`SELECT a.rowid AS ordinal, ${potentiallyLiveRemoteAttachmentSql('a.state')} AS active,
    a.state = 'stopping' AS stopping, dispatch_id AS id, task_id AS task,
    home_run_id AS run, r.home_database AS runHome, terminal_handle AS handle, pane_key AS pane, NULL AS session,
    process_incarnation AS process, NULL AS host, runtime_epoch AS endpoint,
    NULL AS creator, NULL AS creatorHandle, NULL AS creatorPane, NULL AS creatorSession,
    NULL AS retry, home_peer_fingerprint AS home, NULL AS coordinator,
    NULL AS coordinatorPane, NULL AS coordinatorSession
    FROM remote_dispatch_attachments a JOIN runs r ON r.id = a.home_run_id WHERE a.rowid IN (
      SELECT rowid FROM remote_dispatch_attachments WHERE terminal_handle IN (SELECT value FROM json_each(?))
      UNION SELECT rowid FROM remote_dispatch_attachments WHERE pane_key IN (SELECT value FROM json_each(?))
      UNION SELECT rowid FROM remote_dispatch_attachments WHERE pane_key IS NOT NULL AND ${REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL} IN (SELECT value FROM json_each(?))
      UNION SELECT rowid FROM remote_dispatch_attachments WHERE dispatch_id IN (SELECT value FROM json_each(?)))
    ORDER BY dispatch_id`)
        .all(handles, paneKeys, leaves, ids)
    )
    .map(({ ordinal, active, stopping, ...row }): CrewParentClaim => ({
      ...row,
      family: 'remote',
      remoteRoute: { ordinal, active: active === 1, stopping: stopping === 1 }
    }))
  const claims = [...local, ...remote]
  const creators = claim
    .array()
    .parse(
      db.db
        .prepare(`SELECT ${localColumns}
    FROM dispatch_contexts d JOIN runs r ON r.id = d.run_id
    LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
    WHERE d.id IN (SELECT value FROM json_each(?)) ORDER BY d.id`)
        .all(
          JSON.stringify([...new Set(local.flatMap((row) => (row.creator ? [row.creator] : [])))])
        )
    )
    .map((row): CrewParentClaim => ({ ...row, family: 'local' }))
  const resources = resource.array().parse(
    db.db
      .prepare(`SELECT id, origin_dispatch_id AS origin,
    owner_dispatch_id AS owner, prior_owner_dispatch_ids AS prior, terminal_handle AS handle,
    pane_key AS pane, process_incarnation AS process, host_scope AS host, endpoint_id AS endpoint,
    endpoint_incarnation AS endpointProcess, ownership_state AS ownership
    FROM worker_terminal_resources WHERE rowid IN (
      SELECT rowid FROM worker_terminal_resources WHERE terminal_handle IN (SELECT value FROM json_each(?))
      UNION SELECT rowid FROM worker_terminal_resources WHERE pane_key IN (SELECT value FROM json_each(?))
      UNION SELECT rowid FROM worker_terminal_resources WHERE pane_key IS NOT NULL AND ${REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL} IN (SELECT value FROM json_each(?))
      UNION SELECT rowid FROM worker_terminal_resources WHERE owner_dispatch_id IN (SELECT value FROM json_each(?)))`)
      .all(handles, paneKeys, leaves, JSON.stringify(claims.map((row) => row.id)))
  )
  const creatorAssignments = readCrewAssignmentIds(
    db,
    creators.map((row) => row.id)
  )
  return { claims, creators, resources, creatorAssignments }
}
export type CrewParentInputs = ReturnType<typeof readCrewParentInputs> & {
  sourceFingerprint: string | null
}
