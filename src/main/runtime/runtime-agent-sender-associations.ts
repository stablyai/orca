import type {
  AgentSenderAssociation,
  AgentSenderPublication
} from '../../shared/agent-sender-associations'
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
/** Bounded like the hook server's per-pane maps; eviction only forgets an old respawn. */
const MAX_HANDLE_INCARNATIONS = 4096

/** Publishes where each sender a card saves runs now: the terminal its handle names, the worker
 *  lineage a Dispatch continued into, and chats by session. Terminal and chat inputs rebuild
 *  separately, only when the facts they read change; status ticks and leases rebuild nothing. */
export class RuntimeAgentSenderAssociations {
  private database: OrchestrationDb | null = null
  private revision = ''
  private principals: AgentSenderPrincipal[] = []
  private historyReads = 0
  private chatReads = 0
  private readonly work = { lineageReads: 0 }
  workForTest() {
    return {
      historyReads: this.historyReads,
      chatReads: this.chatReads,
      lineageReads: this.work.lineageReads
    }
  }
  /** The process each handle was first seen running; a respawn that kept the handle is not it. */
  private readonly handleIncarnations = new Map<string, string>()
  private terminalKey: unknown[] = []
  private failedKey: unknown[] = []
  private terminal: Pick<Scope, 'associations' | 'attachments'> = {
    associations: [],
    attachments: []
  }
  private chatKey: unknown[] = []
  private chats: AgentSenderAssociation[] = []
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

  private livePanes(): Map<string, AgentSenderPane & { original: boolean }> {
    const panes = new Map<string, AgentSenderPane & { original: boolean }>()
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
      const processIncarnation = pty?.incarnationId ? `${pty.ptyId}:${pty.incarnationId}` : null
      panes.set(paneKey, {
        paneKey,
        worktreeId,
        handle,
        processIncarnation,
        original: this.originalExecution(handle, processIncarnation)
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

  /** A handle names the execution it was issued to; restart reattach keeps both, but a respawn
   *  that kept the handle runs a fresh shell, so its old cards no longer name what runs there. */
  private originalExecution(handle: string, incarnation: string | null): boolean {
    if (!incarnation) {
      return true
    }
    const first = this.handleIncarnations.get(handle)
    if (first === undefined) {
      this.handleIncarnations.set(handle, incarnation)
      if (this.handleIncarnations.size > MAX_HANDLE_INCARNATIONS) {
        const oldest = this.handleIncarnations.keys().next().value
        if (oldest !== undefined) {
          this.handleIncarnations.delete(oldest)
        }
      }
    }
    return first === undefined || first === incarnation
  }

  private refresh(): void {
    const db = this.deps.getDb()
    if (db !== this.database) {
      this.database = db
      this.revision = ''
      this.principals = []
    }
    const revision = db ? readAgentSenderGeneration(db, this.revision === '') : ''
    const panes = this.livePanes()
    const peerFingerprint = this.deps.peerFingerprint()
    const terminalKey = [
      revision,
      JSON.stringify(
        [...panes.values()].map((p) => [
          p.paneKey,
          p.worktreeId,
          p.handle,
          p.processIncarnation,
          p.original
        ])
      ),
      peerFingerprint
    ]
    const records = this.deps.getSessionRecords()
    // A store says when what chats read changed; a reader without it is listed.
    const chatKey = [
      records?.listRecords,
      records?.senderIdentityRevision
        ? records.senderIdentityRevision()
        : JSON.stringify([
            records?.listRecords().map((r) => [r.sessionId, r.location, r.conversationCommand]),
            records?.getVisibleSessionTabIndex?.()
          ])
    ]
    const terminalChanged =
      !same(terminalKey, this.terminalKey) && !same(terminalKey, this.failedKey)
    const chatsChanged = !same(chatKey, this.chatKey)
    if (chatsChanged) {
      this.chatReads++
      this.chats = readAgentSenderSessions(records)
      this.chatKey = chatKey
    }
    if (terminalChanged) {
      this.readTerminals(db, revision, panes, terminalKey)
    }
    if (terminalChanged || chatsChanged) {
      this.publish({
        associations: [...this.terminal.associations, ...this.chats],
        principals: db ? this.principals : [],
        attachments: this.terminal.attachments,
        ...(peerFingerprint ? { peerFingerprint } : {})
      })
    }
  }

  private readTerminals(
    db: OrchestrationDb | null,
    revision: string,
    panes: Map<string, AgentSenderPane & { original: boolean }>,
    key: unknown[]
  ): void {
    let read: ReturnType<typeof readAgentSenderWorkers> = { workers: [], remote: [] }
    try {
      if (db) {
        this.historyReads++
        read = readAgentSenderWorkers(db, [...panes.values()], this.work)
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
    this.terminalKey = key
    this.failedKey = []
    const rows = new Map<string, AgentSenderAssociation>()
    const add = (identity: string, paneKey: string) => {
      const pane = panes.get(paneKey)
      // A live handle names its own pane before any worker lineage that once used it.
      if (pane && !rows.has(identity)) {
        rows.set(identity, { identity, paneKey, worktreeId: pane.worktreeId })
      }
    }
    for (const pane of panes.values()) {
      if (pane.original) {
        add(pane.handle, pane.paneKey)
      }
    }
    for (const worker of read.workers) {
      add(worker.identity, worker.paneKey)
    }
    this.terminal = {
      associations: [...rows.values()],
      attachments: read.remote.flatMap((worker) => {
        const pane = panes.get(worker.paneKey)
        return pane
          ? [
              {
                identity: worker.identity,
                paneKey: worker.paneKey,
                worktreeId: pane.worktreeId,
                homePeerFingerprint: worker.homePeerFingerprint
              }
            ]
          : []
      })
    }
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

function same(key: unknown[], other: unknown[]): boolean {
  return key.length === other.length && key.every((value, i) => value === other[i])
}
