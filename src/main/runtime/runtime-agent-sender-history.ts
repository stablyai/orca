import { z } from 'zod'
import type {
  AgentSenderAssociation,
  AgentSenderPublication
} from '../../shared/agent-sender-associations'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import {
  createCanonicalSessionResolver,
  type AgentSessionRecordReader
} from './orchestration/structured-session-lineage'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  resolveWorkerLineage,
  type WorkerLineage
} from './orchestration/db/dispatch-context/worker-follow-up-lineage'
import { parseWorkerTerminalPriorOwnerIds } from './orchestration/db/pane-key-match'
import type { WorkerTerminalResourceRow } from './orchestration/worker-terminal-ownership'
import { potentiallyLiveRemoteAttachmentSql } from './orchestration/db/federation/remote-attachment-liveness'
import { isStructuredWorkerHandle } from '../../shared/structured-worker-handle'
import type { OrchestrationDb } from './orchestration/db'

export type AgentSenderPrincipal = AgentSenderPublication['principals'][number]
/** A live terminal as this host runs it now. */
export type AgentSenderPane = {
  paneKey: string
  worktreeId: string
  handle: string
  processIncarnation: string | null
}
/** An identity (`dispatch:<id>`, or an earlier handle of that worker) located in a live pane. */
export type AgentSenderWorker = { identity: string; paneKey: string }

const remoteRow = z.object({
  dispatchId: z.string(),
  homePeerFingerprint: z.string(),
  processIncarnation: z.string().nullable()
})
const assignedRow = z.object({ id: z.string(), handle: z.string().nullable() })
const environmentRow = z.object({ environmentId: z.string() })

const tolerant = <T>(schema: z.ZodType<T>, rows: unknown[]): T[] =>
  rows.flatMap((row) => {
    const parsed = schema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })

const HISTORY_TRIGGERS = [
  [
    'dispatch_contexts',
    'status, assignee_handle, assignee_pane_key, assignee_orca_session_id, follow_up_of_dispatch_id'
  ],
  [
    'worker_terminal_resources',
    'owner_dispatch_id, pane_key, terminal_handle, prior_owner_dispatch_ids, ownership_state, release_state, retained_reason, process_incarnation'
  ],
  ['remote_dispatch_attachments', 'state, pane_key, home_peer_fingerprint, process_incarnation'],
  ['federated_dispatches', 'environment_id']
] as const

// Why connection-local triggers: identity rebuilds follow writes to the facts the history reads,
// from any writer, never heartbeats, receipts, read marks or mail; nothing persists for older builds.
const GENERATION_SQL = `
CREATE TEMP TABLE IF NOT EXISTS agent_sender_generation (history INTEGER NOT NULL);
INSERT INTO temp.agent_sender_generation SELECT 0
  WHERE NOT EXISTS (SELECT 1 FROM temp.agent_sender_generation);
${HISTORY_TRIGGERS.flatMap(([table, columns]) =>
  [
    ['insert', 'AFTER INSERT'],
    ['delete', 'AFTER DELETE'],
    ['update', `AFTER UPDATE OF ${columns}`]
  ].map(
    ([name, event]) => `CREATE TEMP TRIGGER IF NOT EXISTS agent_sender_${table}_${name}
${event} ON main.${table}
BEGIN UPDATE temp.agent_sender_generation SET history = history + 1; END;`
  )
).join('\n')}`

/** Install the triggers once per connection, then read the generation they keep. */
export function readAgentSenderGeneration(db: OrchestrationDb, install: boolean): string {
  if (install) {
    db.db.exec(GENERATION_SQL)
  }
  const row = z
    .object({ history: z.number() })
    .parse(db.db.prepare('SELECT history FROM temp.agent_sender_generation').get())
  // data_version moves only for other connections' commits, which the triggers cannot see.
  return `${row.history}:${String(db.db.pragma('data_version', { simple: true }))}`
}

// Each reads one live pane through an index; the active and potentially-live predicates are the
// partial indexes' own, so neither scans every Dispatch or attachment that pane ever had.
export const AGENT_SENDER_PANE_READS = {
  resources: 'SELECT * FROM worker_terminal_resources WHERE pane_key = ?',
  assigned: `SELECT id, assignee_handle AS handle FROM dispatch_contexts
    WHERE assignee_pane_key = ? AND status IN ('pending', 'dispatched')`,
  attachments: `SELECT dispatch_id AS dispatchId, home_peer_fingerprint AS homePeerFingerprint,
      process_incarnation AS processIncarnation
    FROM remote_dispatch_attachments WHERE pane_key = ? AND ${potentiallyLiveRemoteAttachmentSql()}`
} as const

/** The worker still runs this very execution: its terminal is held and was recorded on this
 *  process. A missing incarnation proves nothing. */
function holdsWorker(resource: WorkerTerminalResourceRow, pane: AgentSenderPane): boolean {
  return (
    resource.ownership_state !== 'released' &&
    resource.release_state !== 'released' &&
    resource.retained_reason !== 'identity_unproven' &&
    resource.process_incarnation !== null &&
    resource.process_incarnation === pane.processIncarnation
  )
}

/** Bounded by live panes: the workers each holds, the lineage that continues into each, and
 *  federated workers still potentially running there. */
export function readAgentSenderWorkers(
  db: OrchestrationDb,
  panes: readonly AgentSenderPane[],
  work: { lineageReads: number }
): {
  workers: AgentSenderWorker[]
  remote: (AgentSenderWorker & { homePeerFingerprint: string })[]
} {
  const byKey = new Map(panes.map((pane) => [pane.paneKey, pane]))
  const remote: (AgentSenderWorker & { homePeerFingerprint: string })[] = []
  const resources = db.db.prepare(AGENT_SENDER_PANE_READS.resources)
  const assigned = db.db.prepare(AGENT_SENDER_PANE_READS.assigned)
  const attachments = db.db.prepare(AGENT_SENDER_PANE_READS.attachments)
  const former = new Map<string, WorkerTerminalResourceRow>()
  const candidates = new Set<string>()
  for (const pane of panes) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
    for (const row of resources.all(pane.paneKey) as WorkerTerminalResourceRow[]) {
      if (!holdsWorker(row, pane)) {
        continue
      }
      // A malformed list loses only that row's former owners, as the release path tolerates it.
      const priors = parseWorkerTerminalPriorOwnerIds(row.prior_owner_dispatch_ids) ?? []
      for (const id of [row.owner_dispatch_id, row.origin_dispatch_id, ...priors]) {
        candidates.add(id)
      }
      for (const id of priors) {
        former.set(id, row)
      }
    }
    // Before its terminal is recorded, an active Dispatch counts only on the execution it names.
    for (const row of tolerant(assignedRow, assigned.all(pane.paneKey))) {
      if (row.handle === pane.handle) {
        candidates.add(row.id)
      }
    }
    for (const attachment of tolerant(remoteRow, attachments.all(pane.paneKey))) {
      if (
        attachment.processIncarnation &&
        attachment.processIncarnation === pane.processIncarnation
      ) {
        remote.push({
          identity: `dispatch:${attachment.dispatchId}`,
          paneKey: pane.paneKey,
          homePeerFingerprint: attachment.homePeerFingerprint
        })
      }
    }
  }
  const reader = {
    db: db.db,
    getDispatchContextById: (id: string) => {
      work.lineageReads++
      return db.getDispatchContextById(id)
    },
    getWorkerTerminalResourceByOwner: (id: string) => db.getWorkerTerminalResourceByOwner(id),
    getWorkerTerminalResourceFormerlyOwnedBy: (id: string) => former.get(id)
  }
  // Earlier Dispatches a follow-up continued, back to each lineage's first.
  for (const pending = [...candidates]; pending.length > 0;) {
    const prior = reader.getDispatchContextById(pending.pop() ?? '')?.follow_up_of_dispatch_id
    if (prior && !candidates.has(prior)) {
      candidates.add(prior)
      pending.push(prior)
    }
  }
  const workers: AgentSenderWorker[] = []
  const lineages = new Map<string, WorkerLineage>()
  for (const id of candidates) {
    const lineage = resolveWorkerLineage(reader, id, undefined, lineages)
    if (!lineage || lineage.latest.assignee_orca_session_id) {
      continue
    }
    const { latest, resource } = lineage
    const pane = byKey.get(resource?.pane_key ?? latest.assignee_pane_key ?? '')
    const runs = resource
      ? pane && holdsWorker(resource, pane)
      : pane &&
        latest.assignee_handle === pane.handle &&
        (latest.status === 'pending' || latest.status === 'dispatched') &&
        (!latest.process_incarnation || latest.process_incarnation === pane.processIncarnation)
    if (!pane || !runs) {
      continue
    }
    workers.push({ identity: `dispatch:${id}`, paneKey: pane.paneKey })
    // Cards from the worker's earlier terminal follow it; a live handle still names its own pane.
    const handle = reader.getDispatchContextById(id)?.assignee_handle
    if (handle && !isStructuredWorkerHandle(handle)) {
      workers.push({ identity: handle, paneKey: pane.paneKey })
    }
  }
  return { workers, remote }
}

/** One principal per paired peer, not one route per federated Dispatch ever made. */
export function readAgentSenderPrincipals(
  db: OrchestrationDb,
  principal: (environmentId: string) => AgentSenderPrincipal | undefined
): AgentSenderPrincipal[] {
  return tolerant(
    environmentRow,
    db.db.prepare('SELECT DISTINCT environment_id AS environmentId FROM federated_dispatches').all()
  ).flatMap(({ environmentId }) => {
    const peer = principal(environmentId)
    return peer ? [peer] : []
  })
}

/** Chats with an open tab. Without a recorded tab table the store still knows the workspace's
 *  saved chat tabs, so closed history never counts as open; a reader that can't say counts all. */
function visibleChats(records: AgentSessionRecordReader | null): Set<string> | null {
  const listed = records?.listVisibleSessionIds?.()
  if (listed) {
    return new Set(listed)
  }
  const visibility = records?.getVisibleSessionTabIndex?.()
  return visibility?.present ? new Set(visibility.sessionIds) : null
}

/** Every open chat and, through the store's reverse /clear index, each session whose lineage
 *  reaches one: a row's chat is where its lineage runs now, so no other saved chat yields a row.
 *  Null for a reader without the index or visibility, which lists every chat. */
function senderCandidates(
  records: AgentSessionRecordReader | null,
  visible: Set<string> | null
): Set<string> | null {
  const clearedFrom = records?.listClearedFrom
  if (!visible || !clearedFrom) {
    return null
  }
  const seen = new Set<string>()
  const pending = [...visible]
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (!seen.has(id)) {
      seen.add(id)
      pending.push(...clearedFrom(id))
    }
  }
  return seen
}

/** Visible chats under their own and every /clear predecessor's session id. */
export function readAgentSenderSessions(
  records: AgentSessionRecordReader | null,
  work?: { chatRecords: number }
): AgentSenderAssociation[] {
  const visible = visibleChats(records)
  const ids =
    senderCandidates(records, visible) ?? (records?.listRecords() ?? []).map((r) => r.sessionId)
  const resolve = createCanonicalSessionResolver(records)
  return [...ids].flatMap((sessionId) => {
    if (work) {
      work.chatRecords++
    }
    const destinationId = resolve(sessionId)
    const destination = records?.getRecord(destinationId)
    return !destination ||
      // Local chats, WSL ones included, as the sidebar shows them.
      destination.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
      (visible && !visible.has(destinationId))
      ? []
      : [
          {
            identity: `orca_session_id:${sessionId}`,
            paneKey: structuredAgentSessionPaneKey(
              structuredAgentSessionTabId(destinationId),
              destinationId
            ),
            worktreeId: destination.location.workspaceId,
            sessionId: destinationId
          }
        ]
  })
}
