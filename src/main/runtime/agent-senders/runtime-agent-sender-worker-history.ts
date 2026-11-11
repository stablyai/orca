import { z } from 'zod'
import {
  isEquivalentPaneKey,
  parseWorkerTerminalPriorOwnerIds
} from '../orchestration/db/pane-key-match'
import { getFollowUpDispatch } from '../orchestration/db/dispatch-context/worker-follow-up-lineage'
import type { WorkerTerminalResourceRow } from '../orchestration/terminal-authority/release/worker-terminal-ownership'
import { potentiallyLiveRemoteAttachmentSql } from '../orchestration/db/federation/remote-attachment-liveness'
import { isStructuredWorkerHandle } from '../../../shared/orchestration/workers/structured-worker-handle'
import type { OrchestrationDb } from '../orchestration/db/orchestration-db'
import { tolerant } from './agent-sender-row-decoding'
import {
  agentSenderExecutionKey as executionKey,
  agentSenderPaneFacts as paneFacts
} from './agent-sender-execution-facts'
import type { AgentSenderPane } from './agent-sender-live-panes'
import {
  clearAgentSenderDirtyKeys,
  readAgentSenderDirtyKeys,
  trackAgentSenderHistoryKeys,
  releaseAgentSenderHistoryKeys
} from './runtime-agent-sender-history-triggers'
import { AgentSenderLineageGraph } from './runtime-agent-sender-lineage'

/** An identity (`dispatch:<id>`, or an earlier handle of that worker) located in a live pane. */
export type AgentSenderWorker = { identity: string; paneKey: string; dispatchActor?: true }
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
type DispatchEntry = { parent: string | null; rows: AgentSenderWorker[] }
export type AgentSenderHistoryWork = {
  lineageReads: number
  paneReads: number
  lineageVisits?: number
}

/** Live workers' sender history, kept between builds: a write re-reads only the panes and
 *  Dispatch lineages its keys reach. A commit from another connection, which no trigger sees,
 *  rebuilds everything. */
export class AgentSenderWorkerHistory {
  private readonly slices = new Map<string, PaneSlice>()
  private readonly graph = new AgentSenderLineageGraph()
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
      const previous = this.cold
        ? undefined
        : new Set([
            ...[...this.slices.keys()].map((key) => `p:${key}`),
            ...[...this.graph.keys()].map((id) => `d:${id}`)
          ])
      try {
        this.update(db, panes, live, dirty, work)
        this.cold = false
        if (db.db.isTransaction) {
          // A write that may yet roll back is never kept: the next build starts cold.
          this.reset()
        } else {
          trackAgentSenderHistoryKeys(db, this.slices.keys(), this.graph.keys(), previous)
          clearAgentSenderDirtyKeys(db)
        }
      } catch (error) {
        // Nothing consumed: the next build starts cold and still sees every pending key.
        this.reset()
        throw error
      }
    }
    return this.result
  }

  sizeForTest() {
    return {
      entries: this.graph.sizeForTest().nodes,
      dependencies: this.graph.sizeForTest().nodes + this.slices.size
    }
  }

  graphSizeForTest() {
    return this.graph.sizeForTest()
  }

  release(db: OrchestrationDb | null): void {
    this.reset()
    this.result = { workers: [], remote: [] }
    if (db) {
      releaseAgentSenderHistoryKeys(db)
    }
  }

  private reset(): void {
    this.slices.clear()
    this.graph.clear()
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
    const visit = () => {
      if (work.lineageVisits !== undefined) {
        work.lineageVisits++
      }
    }
    const dispatches = [...dirty].filter((key) => key.startsWith('d:')).map((key) => key.slice(2))
    changed = this.graph.invalidate(dispatches, visit) || changed
    // A write no pane or lineage here read changes nothing: the last result stands.
    if (!changed) {
      return
    }
    const former = new Map(panes.flatMap((pane) => this.slices.get(pane.paneKey)?.former ?? []))
    const read =
      <T>(fn: (id: string) => T) =>
      (id: string) => {
        work.lineageReads++
        return fn(id)
      }
    this.graph.retain(
      [...this.slices.values()].flatMap((slice) => slice.candidates),
      {
        dispatch: read((id) => db.getDispatchContextById(id)),
        ownedResource: read((id) => db.getWorkerTerminalResourceByOwner(id)),
        formerResource: (id) => former.get(id),
        followUp: read((id) => getFollowUpDispatch(db, id))
      },
      visit
    )
    const executions = new Map<string, AgentSenderPane | null>()
    for (const pane of panes) {
      const key = executionKey(pane.processIncarnation, pane.hostScope)
      if (key) {
        executions.set(key, executions.has(key) ? null : pane)
      }
    }
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
        const entry = this.entry(id, live, executions)
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

  private entry(
    id: string,
    live: Map<string, AgentSenderPane>,
    executions: Map<string, AgentSenderPane | null>
  ): DispatchEntry {
    const row = this.graph.row(id)
    const resource = this.graph.resource(id)
    const rows: AgentSenderWorker[] = []
    const sourceKey = row && executionKey(row.process_incarnation, row.host_scope)
    const exact = sourceKey ? executions.get(sourceKey) : undefined
    const sourceResource =
      resource && sourceKey === executionKey(resource.process_incarnation, resource.host_scope)
    const pane = sourceResource ? live.get(resource.pane_key ?? '') : exact
    const runs =
      row &&
      !row.assignee_orca_session_id &&
      exact &&
      pane === exact &&
      row.launch_token_hash &&
      row.launch_token_hash === pane.launchTokenHash &&
      isEquivalentPaneKey(row.assignee_pane_key ?? '', pane.paneKey) &&
      (sourceResource
        ? holdsWorker(resource, pane)
        : row.assignee_handle === pane.handle &&
          (row.status === 'pending' || row.status === 'dispatched'))
    if (pane && runs) {
      rows.push({ identity: `dispatch:${id}`, paneKey: pane.paneKey, dispatchActor: true })
      if (row.assignee_handle && !isStructuredWorkerHandle(row.assignee_handle)) {
        rows.push({ identity: row.assignee_handle, paneKey: pane.paneKey, dispatchActor: true })
      }
    }
    return { parent: row?.follow_up_of_dispatch_id ?? null, rows }
  }
}
