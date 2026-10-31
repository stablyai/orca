import type {
  AgentSenderAssociation,
  AgentSenderPublication
} from '../../shared/agent-sender-associations'
import type { AgentProcessIdentity } from '../../shared/agent-process-presence'
import { isStructuredWorkerHandle } from '../../shared/structured-worker-handle'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { RuntimeAgentOrchestrationDependencies } from './runtime-agent-orchestration-projection'
import {
  readAgentSenderGeneration,
  readAgentSenderPrincipals,
  readAgentSenderSessions,
  readAgentSenderWorkers,
  type AgentSenderPane,
  type AgentSenderPrincipal
} from './runtime-agent-sender-history'
import { AgentSenderConversations } from './runtime-agent-sender-conversations'
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

/** Publishes where each live sender identity runs now; identity work follows identity writes,
 *  conversation changes and live panes, never status ticks. */
export class RuntimeAgentSenderAssociations {
  readonly conversations = new AgentSenderConversations()
  private database: OrchestrationDb | null = null
  private revision = ''
  private principals: AgentSenderPrincipal[] = []
  private historyReads = 0
  private readonly work = { lineageReads: 0 }
  workForTest() {
    return { historyReads: this.historyReads, lineageReads: this.work.lineageReads }
  }
  private key: unknown[] = []
  private failedKey: unknown[] = []
  private attachmentsByPane = new Map<string, string>()
  private readonly attached = new Set<string>()
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

  /** Who a terminal sender is as Orca accepts its event: the worker Dispatch it runs, else the
   *  conversation its pane runs; none when neither is proved. Chats are named by session id. */
  identityAt(db: OrchestrationDb, address: string, paneKey: string | null): string | null {
    if (
      !paneKey ||
      isStructuredWorkerHandle(address) ||
      address.startsWith('orca_session_id:') ||
      address.startsWith('dispatch:')
    ) {
      return null
    }
    const active = db.getActiveDispatchForIdentity(address, paneKey)
    if (active) {
      return active.assignee_orca_session_id ? null : `dispatch:${active.id}`
    }
    return this.conversations.of(paneKey)[0] ?? null
  }

  /** One hook: the pane's conversation, and once per worker Dispatch the conversation it was
   *  attached with, which later proves the pane still holds that worker. */
  observeHook(
    db: OrchestrationDb | null,
    hook: {
      paneKey: string
      agent: string
      session: string
      process: AgentProcessIdentity | undefined
      dispatchId: string | null
    }
  ): void {
    this.conversations.observe(hook.paneKey, hook.agent, hook.session, hook.process)
    const dispatchId = hook.dispatchId ?? this.attachmentsByPane.get(hook.paneKey)
    if (db && dispatchId && !this.attached.has(dispatchId)) {
      this.attached.add(dispatchId)
      db.recordAgentSenderIdentity(`assignee:${dispatchId}`, this.conversations.of(hook.paneKey)[0])
    }
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

  private livePanes(): Map<string, AgentSenderPane> {
    const panes = new Map<string, AgentSenderPane>()
    const ptys = new Map([...this.deps.getPtys()].map((pty) => [pty.ptyId, pty]))
    const terminal = (
      handle: string,
      paneKey: string | null,
      worktreeId: string | null,
      ptyId: string | null
    ) => {
      if (!paneKey || !worktreeId || isStructuredWorkerHandle(handle) || !parsePaneKey(paneKey)) {
        return
      }
      const pty = ptyId ? ptys.get(ptyId) : undefined
      panes.set(paneKey, {
        paneKey,
        worktreeId,
        processIncarnation: pty?.incarnationId ? `${pty.ptyId}:${pty.incarnationId}` : null,
        conversations: this.conversations.of(paneKey)
      })
    }
    for (const leaf of this.deps.getLeaves()) {
      if (leaf.ptyId) {
        terminal(
          this.deps.issueLeafHandle(leaf),
          this.deps.makePaneKey(leaf),
          leaf.worktreeId,
          leaf.ptyId
        )
      }
    }
    for (const pty of ptys.values()) {
      const paneKey = this.deps.paneOf(pty).paneKey
      if (paneKey && !panes.has(paneKey)) {
        terminal(this.deps.issuePtyHandle(pty), paneKey, pty.worktreeId, pty.ptyId)
      }
    }
    return panes
  }

  private refresh(): void {
    const db = this.deps.getDb()
    if (db !== this.database) {
      this.database = db
      this.revision = ''
      this.attached.clear()
    }
    const revision = db ? readAgentSenderGeneration(db, this.revision === '') : ''
    const panes = this.livePanes()
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
      revision,
      this.conversations.generation,
      JSON.stringify(
        [...panes.values()].map((p) => [p.paneKey, p.worktreeId, p.processIncarnation])
      ),
      recordGeneration,
      peerFingerprint
    ]
    const same = (other: unknown[]) =>
      key.length === other.length && key.every((value, i) => value === other[i])
    if (same(this.key) || same(this.failedKey)) {
      return
    }
    let workers: ReturnType<typeof readAgentSenderWorkers> = {
      workers: [],
      remote: [],
      attachedByPane: new Map()
    }
    try {
      if (db) {
        this.historyReads++
        workers = readAgentSenderWorkers(db, [...panes.values()], this.work)
        if (revision !== this.revision) {
          this.principals = readAgentSenderPrincipals(db, this.deps.principal)
          this.revision = revision
        }
      }
    } catch (error) {
      // The last good publication stays; the next identity change retries.
      this.failedKey = key
      throw error
    }
    this.key = key
    this.failedKey = []
    this.attachmentsByPane = workers.attachedByPane
    const row = (identity: string, paneKey: string) => {
      const pane = panes.get(paneKey)
      return pane ? [{ identity, paneKey, worktreeId: pane.worktreeId }] : []
    }
    const associations: AgentSenderAssociation[] = [
      ...[...panes.values()].flatMap((pane) =>
        pane.conversations.flatMap((identity) => row(identity, pane.paneKey))
      ),
      ...workers.workers.flatMap((worker) => row(worker.identity, worker.paneKey)),
      ...readAgentSenderSessions(records)
    ]
    const attachments = workers.remote.flatMap((worker) =>
      row(worker.identity, worker.paneKey).map((located) => ({
        ...located,
        homePeerFingerprint: worker.homePeerFingerprint
      }))
    )
    this.publish({
      associations,
      principals: db ? this.principals : [],
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
}
