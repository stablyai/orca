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
  readAgentSenderGeneration,
  readAgentSenderHistory,
  readAgentSenderMail,
  type AgentSenderHistory,
  type AgentSenderPrincipal
} from './runtime-agent-sender-history'
import type { OrchestrationDb } from './orchestration/db'

type Dependencies = RuntimeAgentOrchestrationDependencies & {
  peerFingerprint(): string | undefined
  /** This host's principal as the paired environment authenticates it, and that peer's key. */
  principal(environmentId: string): AgentSenderPrincipal | undefined
}
type Scope = AgentSenderPublication & {
  associations: AgentSenderAssociation[]
  attachments: (AgentSenderAssociation & { homePeerFingerprint: string })[]
}

/** Identity history is read once per identity write, independently of live status publication. */
export class RuntimeAgentSenderAssociations {
  private database: OrchestrationDb | null = null
  private revision = ''
  private failedRevision = ''
  private mailRevision = ''
  private historyReads = 0
  private readonly work = { lineageReads: 0 }
  private mailReads = 0
  workForTest() {
    return {
      historyReads: this.historyReads,
      lineageReads: this.work.lineageReads,
      mailReads: this.mailReads
    }
  }
  private history: AgentSenderHistory | undefined
  private mail = new Map<string, { address: string; paneKey: string }>()
  private mailSequence = 0
  private key: unknown[] = []
  private publication: AgentSenderPublication = {
    associations: [],
    principals: [],
    attachments: []
  }
  private scoped = new Map<string, Scope>()
  private framed = new Map<string, AgentSenderPublication>()
  constructor(private readonly deps: Dependencies) {}

  /** Display bookkeeping: a failure keeps the last good publication and never fails a caller. */
  build(worktreeId?: string): AgentSenderPublication {
    try {
      this.refresh()
    } catch (error) {
      console.warn('[runtime] Sender identity publication failed', error)
    }
    return worktreeId ? this.scope(worktreeId) : this.publication
  }

  /** The scope a client frame carries; remembered so a refresh republishes only changed worktrees. */
  buildForFrame(worktreeId: string): AgentSenderPublication {
    const scope = this.build(worktreeId)
    this.framed.set(worktreeId, scope)
    return scope
  }

  /** Worktrees whose scope differs from the one their last frame carried; an unframed one has no stale client. */
  changedScopes(worktreeIds: Iterable<string>): string[] {
    this.build()
    return [...worktreeIds].filter((id) => {
      const framed = this.framed.get(id)
      return framed !== undefined && framed !== this.scope(id)
    })
  }

  private scope(worktreeId: string): Scope {
    let scoped = this.scoped.get(worktreeId)
    if (!scoped) {
      scoped = { ...this.hostFields(this.publication), associations: [], attachments: [] }
      this.scoped.set(worktreeId, scoped)
    }
    return scoped
  }

  private hostFields(publication: AgentSenderPublication) {
    return {
      principals: publication.principals,
      ...(publication.peerFingerprint ? { peerFingerprint: publication.peerFingerprint } : {})
    }
  }

  private refresh(): void {
    const db = this.deps.getDb()
    if (!db) {
      this.database = null
      this.history = undefined
      this.mail.clear()
    } else {
      const generation = readAgentSenderGeneration(db, db !== this.database)
      if (db !== this.database) {
        this.database = db
        this.revision = ''
        this.failedRevision = ''
      }
      if (generation.history !== this.revision && generation.history !== this.failedRevision) {
        try {
          this.historyReads++
          this.history = readAgentSenderHistory(db, this.deps.principal, this.work)
          this.mail.clear()
          this.mailSequence = 0
          this.mailRevision = ''
          this.revision = generation.history
          this.failedRevision = ''
        } catch (error) {
          // The last good history stays indexed; the next identity write retries.
          this.failedRevision = generation.history
          throw error
        }
      }
      if (generation.mail !== this.mailRevision) {
        this.readMail(db)
        this.mailRevision = generation.mail
      }
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
      const paneKey = this.deps.paneOf(pty).paneKey
      if (paneKey) {
        terminal(this.deps.issuePtyHandle(pty), paneKey, pty.worktreeId)
      }
    }
    const records = this.deps.getSessionRecords()
    const peerFingerprint = this.deps.peerFingerprint()
    // The record store's state is replaced on each committed write; a reader without it is listed.
    const recordGeneration = records?.generation
      ? records.generation()
      : JSON.stringify([
          records?.listRecords().map((r) => [r.sessionId, r.location, r.conversationCommand]),
          records?.getVisibleSessionTabIndex?.()
        ])
    const key = [
      this.revision,
      this.mailRevision,
      JSON.stringify([...handles.values()]),
      recordGeneration,
      peerFingerprint
    ]
    if (key.length === this.key.length && key.every((value, i) => value === this.key[i])) {
      return
    }
    this.key = key
    const associations = [...handles.values()]
    const sessions = records?.listRecords() ?? []
    const visibility = records?.getVisibleSessionTabIndex?.()
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
        : ((paneKey ? panes.get(paneKey) : undefined) ?? (handle ? handles.get(handle) : undefined))
    const workers = this.history?.aliases ?? []
    const workersByAddress = new Map(workers.map((alias) => [alias.address, alias]))
    const mail = [...this.mail.values()].map(
      (row) => workersByAddress.get(row.address) ?? { ...row, handle: null }
    )
    for (const alias of [...workers, ...mail]) {
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
    this.publish({
      associations,
      principals: this.history?.principals ?? [],
      attachments,
      ...(peerFingerprint ? { peerFingerprint } : {})
    })
  }

  private publish(next: Scope): void {
    if (JSON.stringify(next) === JSON.stringify(this.publication)) {
      return
    }
    this.publication = next
    const host = this.hostFields(next)
    const scopes = new Map<string, Scope>()
    const scopeOf = (worktreeId: string) => {
      let scope = scopes.get(worktreeId)
      if (!scope) {
        scope = { ...host, associations: [], attachments: [] }
        scopes.set(worktreeId, scope)
      }
      return scope
    }
    for (const id of this.scoped.keys()) {
      scopeOf(id)
    }
    for (const row of next.associations) {
      scopeOf(row.worktreeId).associations.push(row)
    }
    for (const row of next.attachments) {
      scopeOf(row.worktreeId).attachments.push(row)
    }
    // An unchanged worktree keeps its scope object, so its clients get no frame.
    for (const [id, scope] of scopes) {
      const previous = this.scoped.get(id)
      if (!previous || JSON.stringify(previous) !== JSON.stringify(scope)) {
        this.scoped.set(id, scope)
      }
    }
  }

  private readMail(db: OrchestrationDb): void {
    this.mailReads++
    for (const { sequence, address, paneKey } of readAgentSenderMail(db, this.mailSequence)) {
      this.mail.set(JSON.stringify([address, paneKey]), { address, paneKey })
      this.mailSequence = Math.max(this.mailSequence, sequence)
    }
  }
}
