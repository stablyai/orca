import { z } from 'zod'
import type { AgentSenderPublication } from '../../shared/agent-sender-associations'
import { isStructuredWorkerHandle } from '../../shared/structured-worker-handle'
import {
  resolveWorkerLineage,
  type WorkerLineage
} from './orchestration/db/dispatch-context/worker-follow-up-lineage'
import { parseWorkerTerminalPriorOwnerIds } from './orchestration/db/pane-key-match'
import type { DispatchContextRow } from './orchestration/types'
import type { WorkerTerminalResourceRow } from './orchestration/worker-terminal-ownership'
import type { OrchestrationDb } from './orchestration/db'

export type AgentSenderPrincipal = AgentSenderPublication['principals'][number]
export type AgentSenderAlias = {
  address: string
  paneKey: string | null
  handle: string | null
  sessionId?: string | null
}
export type AgentSenderHistory = ReturnType<typeof readAgentSenderHistory>

const mailRow = z.object({ sequence: z.number(), address: z.string(), paneKey: z.string() })
const remoteRow = z.object({
  dispatchId: z.string(),
  homePeerFingerprint: z.string(),
  paneKey: z.string().nullable(),
  handle: z.string().nullable()
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
    'owner_dispatch_id, pane_key, terminal_handle, prior_owner_dispatch_ids'
  ],
  ['remote_dispatch_attachments', 'pane_key, terminal_handle, home_peer_fingerprint'],
  ['federated_dispatches', 'environment_id']
] as const

// Why connection-local triggers: identity rebuilds follow writes to the facts history reads, from
// any writer, never heartbeats, receipts or read marks; nothing is persisted for older builds.
const GENERATION_SQL = `
CREATE TEMP TABLE IF NOT EXISTS agent_sender_generation (history INTEGER NOT NULL, mail INTEGER NOT NULL);
INSERT INTO temp.agent_sender_generation SELECT 0, 0
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
CREATE TEMP TRIGGER IF NOT EXISTS agent_sender_messages_insert
AFTER INSERT ON main.messages
WHEN NEW.sender_pane_key IS NOT NULL AND NEW.type != 'heartbeat'
BEGIN UPDATE temp.agent_sender_generation SET mail = mail + 1; END;
CREATE TEMP TRIGGER IF NOT EXISTS agent_sender_messages_delete
AFTER DELETE ON main.messages
BEGIN UPDATE temp.agent_sender_generation SET history = history + 1; END;`

/** Install the triggers once per connection, then read the generations they keep. */
export function readAgentSenderGeneration(
  db: OrchestrationDb,
  install: boolean
): { history: string; mail: string } {
  if (install) {
    db.db.exec(GENERATION_SQL)
  }
  const row = z
    .object({ history: z.number(), mail: z.number() })
    .parse(db.db.prepare('SELECT history, mail FROM temp.agent_sender_generation').get())
  // data_version moves only for other connections' commits, which the triggers cannot see.
  const external = String(db.db.pragma('data_version', { simple: true }))
  return { history: `${row.history}:${external}`, mail: `${row.mail}:${external}` }
}

/** Mail provenance written after `afterSequence`, oldest first. */
export function readAgentSenderMail(db: OrchestrationDb, afterSequence: number) {
  return tolerant(
    mailRow,
    db.db
      .prepare(
        `SELECT sequence, from_handle AS address, sender_pane_key AS paneKey FROM messages
         WHERE sequence > ? AND sender_pane_key IS NOT NULL AND type != 'heartbeat'
         ORDER BY sequence`
      )
      .all(afterSequence)
  )
}

export function readAgentSenderHistory(
  db: OrchestrationDb,
  principal: (environmentId: string) => AgentSenderPrincipal | undefined,
  work: { lineageReads: number }
) {
  const dispatchRows = db.db.prepare('SELECT * FROM dispatch_contexts').all()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: private complete schema rows feed the lineage resolver, never the public projection.
  const dispatches = dispatchRows as DispatchContextRow[]
  const resourceRows = db.db
    .prepare('SELECT * FROM worker_terminal_resources ORDER BY updated_at')
    .all()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: complete resource schema rows are the existing lineage resolver's private inputs.
  const resources = resourceRows as WorkerTerminalResourceRow[]
  const byId = new Map(dispatches.map((r) => [r.id, r]))
  const followUps = new Map(
    dispatches.filter((r) => r.follow_up_of_dispatch_id).map((r) => [r.follow_up_of_dispatch_id, r])
  )
  const owned = new Map(resources.map((r) => [r.owner_dispatch_id, r]))
  const former = new Map<string, WorkerTerminalResourceRow>()
  for (const row of resources) {
    // A malformed list loses only that row's former owners, as the release path tolerates it.
    for (const id of parseWorkerTerminalPriorOwnerIds(row.prior_owner_dispatch_ids) ?? []) {
      former.set(id, row)
    }
  }
  const reader = {
    db: db.db,
    getDispatchContextById: (id: string) => {
      work.lineageReads++
      return byId.get(id)
    },
    getWorkerTerminalResourceByOwner: (id: string) => owned.get(id),
    getWorkerTerminalResourceFormerlyOwnedBy: (id: string) => former.get(id)
  }
  const aliases: AgentSenderAlias[] = []
  const lineages = new Map<string, WorkerLineage>()
  for (const dispatch of dispatches) {
    const lineage = resolveWorkerLineage(reader, dispatch.id, (id) => followUps.get(id), lineages)
    if (!lineage) {
      continue
    }
    const { latest, resource } = lineage
    const location = {
      paneKey: resource?.pane_key ?? latest.assignee_pane_key,
      handle: resource?.terminal_handle ?? latest.assignee_handle,
      sessionId: latest.assignee_orca_session_id
    }
    aliases.push({ ...location, address: `dispatch:${dispatch.id}` })
    if (dispatch.assignee_handle && !isStructuredWorkerHandle(dispatch.assignee_handle)) {
      aliases.push({ ...location, address: dispatch.assignee_handle })
    }
  }
  const remote = tolerant(
    remoteRow,
    db.db
      .prepare(
        'SELECT dispatch_id AS dispatchId, home_peer_fingerprint AS homePeerFingerprint, pane_key AS paneKey, terminal_handle AS handle FROM remote_dispatch_attachments'
      )
      .all()
  )
  // One principal per paired peer, not one route per federated Dispatch ever made.
  const principals = tolerant(
    environmentRow,
    db.db.prepare('SELECT DISTINCT environment_id AS environmentId FROM federated_dispatches').all()
  ).flatMap(({ environmentId }) => {
    const peer = principal(environmentId)
    return peer ? [peer] : []
  })
  return { aliases, remote, principals }
}
