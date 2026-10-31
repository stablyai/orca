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
  createCanonicalSessionPaneResolver,
  type AgentSessionRecordReader
} from './orchestration/structured-session-lineage'
import { structuredWorkerHostScope } from './structured-worker-identity'
import {
  resolveWorkerLineage,
  type WorkerLineage
} from './orchestration/db/dispatch-context/worker-follow-up-lineage'
import { parseWorkerTerminalPriorOwnerIds } from './orchestration/db/pane-key-match'
import type { WorkerTerminalResourceRow } from './orchestration/worker-terminal-ownership'
import type { OrchestrationDb } from './orchestration/db'

export type AgentSenderPrincipal = AgentSenderPublication['principals'][number]
/** A live pane as this host runs it now. */
export type AgentSenderPane = {
  paneKey: string
  worktreeId: string
  processIncarnation: string | null
  /** Conversations proved to be the one running here now, newest first. */
  conversations: readonly string[]
}
/** A worker identity whose Dispatch lineage ends in a pane that still holds that worker. */
export type AgentSenderWorker = { identity: string; paneKey: string }

const remoteRow = z.object({
  dispatchId: z.string(),
  homePeerFingerprint: z.string(),
  processIncarnation: z.string().nullable()
})
const environmentRow = z.object({ environmentId: z.string() })

const tolerant = <T>(schema: z.ZodType<T>, rows: unknown[]): T[] =>
  rows.flatMap((row) => {
    const parsed = schema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })

const HISTORY_TRIGGERS = [
  [
    'dispatch_contexts',
    'assignee_handle, assignee_pane_key, assignee_orca_session_id, follow_up_of_dispatch_id'
  ],
  [
    'worker_terminal_resources',
    'owner_dispatch_id, pane_key, terminal_handle, prior_owner_dispatch_ids, ownership_state, retained_reason, process_incarnation'
  ],
  ['remote_dispatch_attachments', 'pane_key, home_peer_fingerprint, process_incarnation'],
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
).join('\n')}
CREATE TEMP TRIGGER IF NOT EXISTS agent_sender_assignee_insert
AFTER INSERT ON main.agent_sender_identities WHEN NEW.subject LIKE 'assignee:%'
BEGIN UPDATE temp.agent_sender_generation SET history = history + 1; END;`

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

/** The worker a pane holds counts only while the conversation it was attached with still runs
 *  there; before its first hook, only while nothing else has claimed the pane. */
function holdsWorker(db: OrchestrationDb, dispatchId: string, pane: AgentSenderPane): boolean {
  const attached = db.getAgentSenderIdentity(`assignee:${dispatchId}`)
  return attached ? pane.conversations.includes(attached) : pane.conversations.length === 0
}

/** Bounded by live panes: their resources and Dispatches, the lineage that continues into each,
 *  and federated attachments. */
export function readAgentSenderWorkers(
  db: OrchestrationDb,
  panes: readonly AgentSenderPane[],
  work: { lineageReads: number }
): {
  workers: AgentSenderWorker[]
  remote: (AgentSenderWorker & { homePeerFingerprint: string })[]
  /** Each live pane's attached federated Dispatch, proved or not, so its first hook can attach it. */
  attachedByPane: Map<string, string>
} {
  const byKey = new Map(panes.map((pane) => [pane.paneKey, pane]))
  const remote: (AgentSenderWorker & { homePeerFingerprint: string })[] = []
  const attachedByPane = new Map<string, string>()
  const resources = db.db.prepare('SELECT * FROM worker_terminal_resources WHERE pane_key = ?')
  const assigned = db.db.prepare(
    'SELECT id FROM dispatch_contexts WHERE assignee_pane_key = ? AND assignee_orca_session_id IS NULL'
  )
  const attachments = db.db.prepare(
    `SELECT dispatch_id AS dispatchId, home_peer_fingerprint AS homePeerFingerprint,
       process_incarnation AS processIncarnation
     FROM remote_dispatch_attachments WHERE pane_key = ?`
  )
  // A replaced process or a released resource is evidence against the worker; neither proves it.
  const fenced = (recorded: string | null, pane: AgentSenderPane) =>
    Boolean(recorded && pane.processIncarnation && recorded !== pane.processIncarnation)
  const former = new Map<string, WorkerTerminalResourceRow>()
  const candidates = new Set<string>()
  for (const pane of panes) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
    for (const row of resources.all(pane.paneKey) as WorkerTerminalResourceRow[]) {
      // A malformed list loses only that row's former owners, as the release path tolerates it.
      const priors = parseWorkerTerminalPriorOwnerIds(row.prior_owner_dispatch_ids) ?? []
      for (const id of [row.owner_dispatch_id, row.origin_dispatch_id, ...priors]) {
        candidates.add(id)
      }
      for (const id of priors) {
        former.set(id, row)
      }
    }
    for (const { id } of tolerant(z.object({ id: z.string() }), assigned.all(pane.paneKey))) {
      candidates.add(id)
    }
    for (const attachment of tolerant(remoteRow, attachments.all(pane.paneKey))) {
      if (fenced(attachment.processIncarnation, pane)) {
        continue
      }
      attachedByPane.set(pane.paneKey, attachment.dispatchId)
      if (holdsWorker(db, attachment.dispatchId, pane)) {
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
    const resource = lineage?.resource
    const pane = byKey.get(resource?.pane_key ?? lineage?.latest.assignee_pane_key ?? '')
    if (
      !lineage ||
      !pane ||
      lineage.latest.assignee_orca_session_id ||
      (resource &&
        (resource.ownership_state === 'released' ||
          resource.retained_reason === 'identity_unproven' ||
          fenced(resource.process_incarnation, pane))) ||
      !holdsWorker(db, lineage.latest.id, pane)
    ) {
      continue
    }
    workers.push({ identity: `dispatch:${id}`, paneKey: pane.paneKey })
  }
  return { workers, remote, attachedByPane }
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

/** Visible chats under their own and every /clear predecessor's session id. */
export function readAgentSenderSessions(
  records: AgentSessionRecordReader | null
): AgentSenderAssociation[] {
  const sessions = records?.listRecords() ?? []
  const visibility = records?.getVisibleSessionTabIndex?.()
  const resolve = createCanonicalSessionPaneResolver(records)
  const visible = visibility?.present ? new Set(visibility.sessionIds) : null
  const byPane = new Map(
    sessions.map((r) => [
      structuredAgentSessionPaneKey(structuredAgentSessionTabId(r.sessionId), r.sessionId),
      r
    ])
  )
  return sessions.flatMap((record) => {
    const paneKey = resolve(record.sessionId)
    const destination = byPane.get(paneKey)
    const sessionId = destination?.sessionId
    return !destination ||
      !sessionId ||
      !structuredWorkerHostScope(destination.location) ||
      (visible && !visible.has(sessionId))
      ? []
      : [
          {
            identity: `orca_session_id:${record.sessionId}`,
            paneKey,
            worktreeId: destination.location.workspaceId,
            sessionId
          }
        ]
  })
}
