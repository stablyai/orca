import { z } from 'zod'
import type {
  AgentSenderAssociation,
  AgentSenderPublication
} from '../../shared/agent-sender-associations'
import { isStructuredWorkerHandle } from '../../shared/structured-worker-handle'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { RuntimeAgentOrchestrationDependencies } from './runtime-agent-orchestration-projection'
import { createCanonicalSessionPaneResolver } from './orchestration/structured-session-lineage'
import { structuredWorkerHostScope } from './structured-worker-identity'
import {
  resolveWorkerLineage,
  type WorkerLineage
} from './orchestration/db/dispatch-context/worker-follow-up-lineage'
import type { DispatchContextRow } from './orchestration/types'
import type { WorkerTerminalResourceRow } from './orchestration/worker-terminal-ownership'
import type { OrchestrationDb } from './orchestration/db'

type Dependencies = RuntimeAgentOrchestrationDependencies & {
  peerFingerprint(): string | undefined
  homePeerFingerprint(environmentId: string): string | undefined
}
const mailSchema = z.array(z.object({ address: z.string(), paneKey: z.string() }))
const remoteSchema = z.array(
  z.object({
    dispatchId: z.string(),
    homePeerFingerprint: z.string(),
    paneKey: z.string().nullable(),
    handle: z.string().nullable()
  })
)
const federationSchema = z.array(
  z.object({ dispatchId: z.string(), peerFingerprint: z.string(), environmentId: z.string() })
)

/** Identity history is batched once per database revision, independently of live status publication. */
export class RuntimeAgentSenderAssociations {
  private database: OrchestrationDb | null = null
  private revision = ''
  private lineageReads = 0
  workForTest() {
    return { lineageReads: this.lineageReads }
  }
  private history: ReturnType<RuntimeAgentSenderAssociations['readHistory']> | undefined
  private key = ''
  private publication: AgentSenderPublication = {
    associations: [],
    federation: [],
    attachments: []
  }
  private scoped = new Map<
    string,
    AgentSenderPublication & {
      associations: AgentSenderAssociation[]
      attachments: (AgentSenderAssociation & { homePeerFingerprint: string })[]
    }
  >()
  constructor(private readonly deps: Dependencies) {}

  build(worktreeId?: string): AgentSenderPublication {
    const db = this.deps.getDb()
    const revision = db
      ? JSON.stringify([
          db.db.prepare('SELECT total_changes() AS n').get(),
          db.db.pragma('data_version')
        ])
      : ''
    if (db !== this.database || revision !== this.revision) {
      this.database = db
      this.revision = revision
      this.history = db ? this.readHistory(db) : undefined
      this.key = ''
    }
    const panes = new Map<string, AgentSenderAssociation>()
    const handles = new Map<string, AgentSenderAssociation>()
    const terminal = (handle: string, paneKey: string | null, workspace: string | null) => {
      if (!paneKey || !workspace || isStructuredWorkerHandle(handle) || !parsePaneKey(paneKey)) {
        return
      }
      const row = { address: handle, paneKey, worktreeId: workspace }
      panes.set(paneKey, row)
      handles.set(handle, row)
    }
    for (const leaf of this.deps.getLeaves()) {
      if (leaf.ptyId) {
        terminal(this.deps.issueLeafHandle(leaf), this.deps.makePaneKey(leaf), leaf.worktreeId)
      }
    }
    for (const pty of this.deps.getPtys()) {
      terminal(this.deps.issuePtyHandle(pty), this.deps.paneOf(pty).paneKey, pty.worktreeId)
    }
    const records = this.deps.getSessionRecords()
    const sessions = records?.listRecords() ?? []
    const visibility = records?.getVisibleSessionTabIndex?.()
    const peerFingerprint = this.deps.peerFingerprint()
    const federation = this.history?.federation ?? []
    const key = JSON.stringify([
      this.revision,
      [...handles.values()],
      sessions.map((r) => [r.sessionId, r.location, r.conversationCommand]),
      visibility,
      peerFingerprint,
      federation
    ])
    if (key !== this.key) {
      this.key = key
      const associations = [...handles.values()]
      const resolve = createCanonicalSessionPaneResolver(records)
      const visible = visibility?.present ? new Set(visibility.sessionIds) : null
      const sessionRows = new Map<string, AgentSenderAssociation>()
      const byPane = new Map(
        sessions.map((r) => [
          structuredAgentSessionPaneKey(structuredAgentSessionTabId(r.sessionId), r.sessionId),
          r
        ])
      )
      for (const record of sessions) {
        const paneKey = resolve(record.sessionId)
        const destination = byPane.get(paneKey)
        const sessionId = destination?.sessionId
        if (
          !destination ||
          !sessionId ||
          !structuredWorkerHostScope(destination.location) ||
          (visible && !visible.has(sessionId))
        ) {
          continue
        }
        const row = {
          address: `orca_session_id:${record.sessionId}`,
          paneKey,
          worktreeId: destination.location.workspaceId,
          sessionId
        }
        sessionRows.set(record.sessionId, row)
        associations.push(row)
      }
      const locate = (paneKey: string | null, handle: string | null, session?: string | null) =>
        session
          ? sessionRows.get(session)
          : ((paneKey ? panes.get(paneKey) : undefined) ??
            (handle ? handles.get(handle) : undefined))
      for (const alias of this.history?.aliases ?? []) {
        const row = locate(alias.paneKey, alias.handle, alias.sessionId)
        if (row && !isStructuredWorkerHandle(alias.address)) {
          associations.push({ ...row, address: alias.address })
        }
      }
      const attachments = (this.history?.remote ?? []).flatMap((attachment) => {
        const row = locate(attachment.paneKey, attachment.handle)
        return row
          ? [
              {
                ...row,
                address: `dispatch:${attachment.dispatchId}`,
                homePeerFingerprint: attachment.homePeerFingerprint
              }
            ]
          : []
      })
      const publication = {
        associations,
        federation,
        attachments,
        ...(peerFingerprint ? { peerFingerprint } : {})
      }
      if (JSON.stringify(publication) !== JSON.stringify(this.publication)) {
        this.publication = publication
        this.scoped.clear()
        const worktrees = new Set([...associations, ...attachments].map((r) => r.worktreeId))
        for (const id of worktrees) {
          this.scoped.set(id, { ...publication, associations: [], attachments: [] })
        }
        for (const row of associations) {
          this.scoped.get(row.worktreeId)?.associations.push(row)
        }
        for (const row of attachments) {
          this.scoped.get(row.worktreeId)?.attachments.push(row)
        }
      }
    }
    if (!worktreeId) {
      return this.publication
    }
    let scoped = this.scoped.get(worktreeId)
    if (!scoped) {
      scoped = {
        ...this.publication,
        associations: [],
        attachments: []
      }
      this.scoped.set(worktreeId, scoped)
    }
    return scoped
  }

  private readHistory(db: OrchestrationDb) {
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
      dispatches
        .filter((r) => r.follow_up_of_dispatch_id)
        .map((r) => [r.follow_up_of_dispatch_id, r])
    )
    const owned = new Map(resources.map((r) => [r.owner_dispatch_id, r]))
    const former = new Map<string, WorkerTerminalResourceRow>()
    for (const row of resources) {
      for (const id of z.array(z.string()).parse(JSON.parse(row.prior_owner_dispatch_ids))) {
        former.set(id, row)
      }
    }
    const reader = {
      db: db.db,
      getDispatchContextById: (id: string) => {
        this.lineageReads++
        return byId.get(id)
      },
      getWorkerTerminalResourceByOwner: (id: string) => owned.get(id),
      getWorkerTerminalResourceFormerlyOwnedBy: (id: string) => former.get(id)
    }
    const aliases: {
      address: string
      paneKey: string | null
      handle: string | null
      sessionId?: string | null
    }[] = []
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
    const workersByAddress = new Map(aliases.map((alias) => [alias.address, alias]))
    for (const mail of mailSchema.parse(
      db.db
        .prepare(
          'SELECT DISTINCT from_handle AS address, sender_pane_key AS paneKey FROM messages WHERE sender_pane_key IS NOT NULL'
        )
        .all()
    )) {
      const worker = workersByAddress.get(mail.address)
      aliases.push(worker ?? { ...mail, handle: null })
    }
    const remote = remoteSchema.parse(
      db.db
        .prepare(
          'SELECT dispatch_id AS dispatchId, home_peer_fingerprint AS homePeerFingerprint, pane_key AS paneKey, terminal_handle AS handle FROM remote_dispatch_attachments'
        )
        .all()
    )
    const routes = federationSchema.parse(
      db.db
        .prepare(
          'SELECT dispatch_id AS dispatchId, peer_fingerprint AS peerFingerprint, environment_id AS environmentId FROM federated_dispatches'
        )
        .all()
    )
    const principals = new Map<string, string | undefined>()
    const federation = routes.flatMap(({ environmentId, ...route }) => {
      if (!principals.has(environmentId)) {
        principals.set(environmentId, this.deps.homePeerFingerprint(environmentId))
      }
      const homePeerFingerprint = principals.get(environmentId)
      return homePeerFingerprint ? [{ ...route, homePeerFingerprint }] : []
    })
    return { aliases, remote, federation }
  }
}
