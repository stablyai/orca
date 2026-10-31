import { z } from 'zod'
import {
  getFollowUpDispatch,
  resolveWorkerLineage,
  type WorkerLineageReader
} from './orchestration/db/dispatch-context/worker-follow-up-lineage'
import { parseWorkerTerminalPriorOwnerIds } from './orchestration/db/pane-key-match'
import type { WorkerTerminalResourceRow } from './orchestration/worker-terminal-ownership'
import { potentiallyLiveRemoteAttachmentSql } from './orchestration/db/federation/remote-attachment-liveness'
import { isStructuredWorkerHandle } from '../../shared/structured-worker-handle'
import type { OrchestrationDb } from './orchestration/db'
import { tolerant, type AgentSenderPane } from './runtime-agent-sender-history'
import {
  clearAgentSenderDirtyKeys,
  readAgentSenderDirtyKeys
} from './runtime-agent-sender-history-triggers'

/** An identity (`dispatch:<id>`, or an earlier handle of that worker) located in a live pane. */
export type AgentSenderWorker = { identity: string; paneKey: string }
type RemoteWorker = AgentSenderWorker & { homePeerFingerprint: string }
export type AgentSenderWorkers = { workers: AgentSenderWorker[]; remote: RemoteWorker[] }

const remoteRow = z.object({
  dispatchId: z.string(),
  homePeerFingerprint: z.string(),
  processIncarnation: z.string().nullable()
})
const assignedRow = z.object({ id: z.string(), handle: z.string().nullable() })

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

/** What one live pane contributes, from its three indexed reads. */
type PaneSlice = {
  facts: string
  candidates: string[]
  former: [string, WorkerTerminalResourceRow][]
  remote: RemoteWorker[]
}
/** One Dispatch's verdict and every key its reads touched, misses included. */
type DispatchEntry = { parent: string | null; rows: AgentSenderWorker[]; deps: string[] }
export type AgentSenderHistoryWork = { lineageReads: number; paneReads: number }

/** Live workers' sender history, kept between builds: a write re-reads only the panes and
 *  Dispatch lineages its keys reach. A commit from another connection, which no trigger sees,
 *  rebuilds everything. */
export class AgentSenderWorkerHistory {
  private readonly slices = new Map<string, PaneSlice>()
  private readonly entries = new Map<string, DispatchEntry>()
  /** Dependency key -> the Dispatch entries whose reads touched it. */
  private readonly dependents = new Map<string, Set<string>>()
  private dataVersion: unknown
  private cold = true
  private result: AgentSenderWorkers = { workers: [], remote: [] }

  read(
    db: OrchestrationDb,
    panes: readonly AgentSenderPane[],
    work: AgentSenderHistoryWork
  ): AgentSenderWorkers {
    const dirty = readAgentSenderDirtyKeys(db)
    const version = db.db.pragma('data_version', { simple: true })
    if (version !== this.dataVersion) {
      this.reset()
      this.dataVersion = version
    }
    const live = new Map(panes.map((pane) => [pane.paneKey, pane]))
    for (const key of this.slices.keys()) {
      if (!live.has(key)) {
        dirty.add(`p:${key}`)
      }
    }
    for (const pane of panes) {
      if (this.slices.get(pane.paneKey)?.facts !== paneFacts(pane)) {
        dirty.add(`p:${pane.paneKey}`)
      }
    }
    if (dirty.size > 0 || this.cold) {
      try {
        this.update(db, panes, live, dirty, work)
        this.cold = false
      } catch (error) {
        // Nothing consumed: the next build starts cold and still sees every pending key.
        this.reset()
        throw error
      }
      clearAgentSenderDirtyKeys(db)
    }
    return this.result
  }

  private reset(): void {
    this.slices.clear()
    this.entries.clear()
    this.dependents.clear()
    this.dataVersion = undefined
    this.cold = true
  }

  private update(
    db: OrchestrationDb,
    panes: readonly AgentSenderPane[],
    live: Map<string, AgentSenderPane>,
    dirty: Set<string>,
    work: AgentSenderHistoryWork
  ): void {
    let changed = this.cold
    // Former-owner keys added below are Dispatch keys, which this loop skips.
    for (const key of dirty) {
      if (!key.startsWith('p:')) {
        continue
      }
      changed = true
      const paneKey = key.slice(2)
      const previous = this.slices.get(paneKey)
      this.slices.delete(paneKey)
      const pane = live.get(paneKey)
      const next = pane ? this.readPane(db, pane, work) : undefined
      if (next) {
        this.slices.set(paneKey, next)
      }
      // A former owner's resource is read from these slices, so its lineage reads change too.
      for (const [id] of [...(previous?.former ?? []), ...(next?.former ?? [])]) {
        dirty.add(`d:${id}`)
      }
    }
    for (const key of dirty) {
      for (const id of this.dependents.get(key) ?? []) {
        this.forget(id)
        changed = true
      }
    }
    // A write no pane or lineage here read changes nothing: the last result stands.
    if (!changed) {
      return
    }
    const former = new Map(panes.flatMap((pane) => this.slices.get(pane.paneKey)?.former ?? []))
    const reads = memoizedReads(db, former, work)
    const workers: AgentSenderWorker[] = []
    const seen = new Set<string>()
    for (const pane of panes) {
      // Earlier Dispatches a follow-up continued, back to each lineage's first.
      for (let pending = [...(this.slices.get(pane.paneKey)?.candidates ?? [])]; ;) {
        const id = pending.pop()
        if (id === undefined) {
          break
        }
        if (seen.has(id)) {
          continue
        }
        seen.add(id)
        const entry = this.entry(id, reads, live)
        workers.push(...entry.rows)
        if (entry.parent) {
          pending.push(entry.parent)
        }
      }
    }
    this.result = {
      workers,
      remote: panes.flatMap((pane) => this.slices.get(pane.paneKey)?.remote ?? [])
    }
  }

  private readPane(db: OrchestrationDb, pane: AgentSenderPane, work: AgentSenderHistoryWork) {
    work.paneReads += 3
    const candidates = new Set<string>()
    const former: [string, WorkerTerminalResourceRow][] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
    const resources = db.db
      .prepare(AGENT_SENDER_PANE_READS.resources)
      .all(pane.paneKey) as WorkerTerminalResourceRow[]
    for (const row of resources) {
      if (!holdsWorker(row, pane)) {
        continue
      }
      // A malformed list loses only that row's former owners, as the release path tolerates it.
      const priors = parseWorkerTerminalPriorOwnerIds(row.prior_owner_dispatch_ids) ?? []
      for (const id of [row.owner_dispatch_id, row.origin_dispatch_id, ...priors]) {
        candidates.add(id)
      }
      former.push(...priors.map((id): [string, WorkerTerminalResourceRow] => [id, row]))
    }
    // Before its terminal is recorded, an active Dispatch counts only on the execution it names.
    const assigned = db.db.prepare(AGENT_SENDER_PANE_READS.assigned).all(pane.paneKey)
    for (const row of tolerant(assignedRow, assigned)) {
      if (row.handle === pane.handle) {
        candidates.add(row.id)
      }
    }
    const attachments = db.db.prepare(AGENT_SENDER_PANE_READS.attachments).all(pane.paneKey)
    const remote = tolerant(remoteRow, attachments).flatMap((attachment) =>
      attachment.processIncarnation && attachment.processIncarnation === pane.processIncarnation
        ? [
            {
              identity: `dispatch:${attachment.dispatchId}`,
              paneKey: pane.paneKey,
              homePeerFingerprint: attachment.homePeerFingerprint
            }
          ]
        : []
    )
    return { facts: paneFacts(pane), candidates: [...candidates], former, remote }
  }

  /** A Dispatch's verdict: the live pane its lineage runs in now, if any. */
  private entry(
    id: string,
    reads: MemoizedReads,
    live: Map<string, AgentSenderPane>
  ): DispatchEntry {
    const cached = this.entries.get(id)
    if (cached) {
      return cached
    }
    const deps = new Set<string>()
    const reader = reads.recording(deps)
    const row = reader.getDispatchContextById(id)
    const lineage = resolveWorkerLineage(reader, id, reader.followUp)
    let rows: AgentSenderWorker[] = []
    if (lineage && !lineage.latest.assignee_orca_session_id) {
      const { latest, resource } = lineage
      const paneKey = resource?.pane_key ?? latest.assignee_pane_key ?? ''
      deps.add(`p:${paneKey}`)
      const pane = live.get(paneKey)
      const runs = resource
        ? pane && holdsWorker(resource, pane)
        : pane &&
          latest.assignee_handle === pane.handle &&
          (latest.status === 'pending' || latest.status === 'dispatched') &&
          (!latest.process_incarnation || latest.process_incarnation === pane.processIncarnation)
      if (pane && runs) {
        rows = [{ identity: `dispatch:${id}`, paneKey }]
        // Cards from the worker's earlier terminal follow it; a live handle still names its own pane.
        if (row?.assignee_handle && !isStructuredWorkerHandle(row.assignee_handle)) {
          rows.push({ identity: row.assignee_handle, paneKey })
        }
      }
    }
    const entry = { parent: row?.follow_up_of_dispatch_id ?? null, rows, deps: [...deps] }
    this.entries.set(id, entry)
    for (const key of entry.deps) {
      this.dependents.set(key, (this.dependents.get(key) ?? new Set()).add(id))
    }
    return entry
  }

  private forget(id: string): void {
    const entry = this.entries.get(id)
    this.entries.delete(id)
    for (const key of entry?.deps ?? []) {
      this.dependents.get(key)?.delete(id)
    }
  }
}

function paneFacts(pane: AgentSenderPane): string {
  return `${pane.handle}\0${pane.processIncarnation ?? ''}`
}

type MemoizedReads = ReturnType<typeof memoizedReads>

/** One refresh's Dispatch, owner and follow-up reads, misses included; each entry records the
 *  keys it read, so a later write to any of them, a new follow-up after a miss included, reaches it. */
function memoizedReads(
  db: OrchestrationDb,
  former: Map<string, WorkerTerminalResourceRow>,
  work: AgentSenderHistoryWork
) {
  const memo = <T>(read: (id: string) => T) => {
    const values = new Map<string, T>()
    return (id: string): T => {
      if (!values.has(id)) {
        work.lineageReads++
        values.set(id, read(id))
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: set just above for this id.
      return values.get(id) as T
    }
  }
  const dispatch = memo((id) => db.getDispatchContextById(id))
  const owner = memo((id) => db.getWorkerTerminalResourceByOwner(id))
  const followUp = memo((id) => getFollowUpDispatch(db, id))
  return {
    recording: (deps: Set<string>): WorkerLineageReader & { followUp: typeof followUp } => {
      const touch =
        <T>(read: (id: string) => T) =>
        (id: string) => {
          deps.add(`d:${id}`)
          return read(id)
        }
      return {
        db: db.db,
        getDispatchContextById: touch(dispatch),
        getWorkerTerminalResourceByOwner: touch(owner),
        getWorkerTerminalResourceFormerlyOwnedBy: touch((id) => former.get(id)),
        followUp: touch(followUp)
      }
    }
  }
}
