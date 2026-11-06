import type {
  AgentSenderAssociation,
  AgentSenderPublication,
  AgentSenderRevision
} from '../../shared/agent-sender-associations'
import type { RuntimeAgentOrchestrationDependencies } from './runtime-agent-orchestration-projection'
import {
  readLiveAgentSenderPanes,
  readAgentSenderPrincipals,
  readAgentSenderSessions,
  type AgentSenderPane,
  type AgentSenderPrincipal
} from './runtime-agent-sender-history'
import {
  AgentSenderWorkerHistory,
  type AgentSenderWorkers
} from './runtime-agent-sender-worker-history'
import { readAgentSenderGeneration } from './runtime-agent-sender-history-triggers'
import type { OrchestrationDb } from './orchestration/db/orchestration-db'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from './terminal/records/runtime-terminal-state-records'
import { AgentSenderPublisher, type AgentSenderScope } from './runtime-agent-sender-publication'

/** The handles terminals already hold, read without issuing one: display bookkeeping never
 *  changes terminal identity, so a terminal with no issued handle has no sender row. */
export type AgentSenderHandleReads = {
  hasPublishedScope?(worktreeId: string): boolean
  readLeafHandle(leaf: RuntimeLeafRecord): string | null
  /** One reader per walk, so a lookup that must index records does it once per build. */
  readPtyHandles(): (pty: RuntimePtyWorktreeRecord) => string | null
}

/** Orchestration issues terminal handles; sender rows only read the ones already issued. */
export type TerminalHandleAccess = Pick<
  RuntimeAgentOrchestrationDependencies,
  'issueLeafHandle' | 'issuePtyHandle'
> &
  AgentSenderHandleReads

type Dependencies = Omit<
  RuntimeAgentOrchestrationDependencies,
  'issueLeafHandle' | 'issuePtyHandle'
> &
  AgentSenderHandleReads & {
    peerFingerprint(): string | undefined
    /** This host's principal as the paired environment authenticates it, and that peer's key. */
    principal(environmentId: string): AgentSenderPrincipal | undefined
    /** Moves when a pairing changes, so principals are read again only then. */
    pairingGeneration(): number
  }
/** Bounded like the hook server's per-pane maps; eviction only forgets an old respawn. */
const MAX_HANDLE_INCARNATIONS = 4096

/** Publishes where each sender a card saves runs now: the terminal its handle names, the worker
 *  lineage a Dispatch continued into, and chats by session. Terminal and chat inputs rebuild
 *  separately, only when the facts they read change; status ticks and leases rebuild nothing. */
export class RuntimeAgentSenderAssociations {
  private database: OrchestrationDb | null = null
  /** Kept per database connection, whose triggers mark what each write can change. */
  private workerHistory = new AgentSenderWorkerHistory()
  private principalsRead = ''
  private pairing = -1
  private principals: AgentSenderPrincipal[] = []
  private historyReads = 0
  private chatReads = 0
  private readonly work = {
    lineageReads: 0,
    paneReads: 0,
    chatRecords: 0,
    leafVisits: 0,
    ptyVisits: 0
  }
  workForTest() {
    return {
      historyReads: this.historyReads,
      chatReads: this.chatReads,
      ...this.work
    }
  }
  /** The process each handle was first seen running; a respawn that kept the handle is not it. */
  private readonly handleIncarnations = new Map<string, string>()
  private terminalKey: unknown[] = []
  private failedKey: unknown[] = []
  private terminal: Pick<AgentSenderScope, 'associations' | 'attachments'> = {
    associations: [],
    attachments: []
  }
  private chatKey: unknown[] = []
  private chats: AgentSenderAssociation[] = []
  readonly publisher = new AgentSenderPublisher((id) => this.deps.hasPublishedScope?.(id) ?? false)
  constructor(private readonly deps: Dependencies) {}

  /** Display bookkeeping: a failure preserves ordinary rows but withdraws unproved workers. */
  build(worktreeId?: string): AgentSenderPublication {
    try {
      this.refresh()
    } catch (error) {
      this.terminal = {
        ...this.terminal,
        associations: this.terminal.associations.filter((row) => row.dispatchActor !== true)
      }
      const current = this.publisher.current()
      if (current.associations.some((row) => row.dispatchActor === true)) {
        // Unread custody cannot prove any worker, including historical aliases; a relevant change retries.
        this.publisher.publish({
          ...current,
          associations: current.associations.filter((row) => row.dispatchActor !== true),
          attachments: [...current.attachments]
        })
      }
      console.warn('[runtime] Sender identity publication failed', error)
    }
    return worktreeId ? this.publisher.scope(worktreeId) : this.publisher.current()
  }

  /** A window graph reply carries the rows only when the window's applied base is stale. */
  buildForGraph(base: AgentSenderRevision | undefined) {
    this.build()
    return this.publisher.forGraph(base)
  }

  /** The scope a client frame carries; remembered so a refresh republishes only changed worktrees. */
  buildForFrame(worktreeId: string): AgentSenderPublication {
    return this.buildForFramePass()(worktreeId)
  }

  /** One refresh for a synchronous pass that frames many worktrees: each reads that one result. */
  buildForFramePass(): (worktreeId: string) => AgentSenderPublication {
    this.build()
    return (worktreeId) => this.publisher.frame(worktreeId)
  }

  acknowledgeFrame(worktreeId: string, scope: AgentSenderPublication): void {
    this.publisher.acknowledgeFrame(worktreeId, scope)
  }

  retireScope(worktreeId: string): void {
    this.publisher.retireScope(worktreeId)
  }

  releaseDerivedHistory(): void {
    try {
      this.workerHistory.release(this.database)
    } catch (error) {
      console.warn('[runtime] Sender identity history cleanup failed', error)
    } finally {
      this.terminalKey = []
      this.failedKey = []
    }
  }

  scopeCountsForTest() {
    return this.publisher.scopeCountsForTest()
  }

  /** Worktrees whose scope differs from the one their last frame carried; an unframed one has no stale client. */
  changedScopes(worktreeIds: Iterable<string>): string[] {
    this.build()
    return this.publisher.changedScopes(worktreeIds)
  }

  private livePanes() {
    return readLiveAgentSenderPanes(this.deps, this.work, (handle, incarnation) =>
      this.originalExecution(handle, incarnation)
    )
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
    const install = db !== this.database
    if (install) {
      this.database = db
      this.workerHistory = new AgentSenderWorkerHistory()
      this.principalsRead = ''
      this.principals = []
    }
    const generation = db ? readAgentSenderGeneration(db, install) : null
    const panes = this.livePanes()
    const peerFingerprint = this.deps.peerFingerprint()
    // Primitives compared in place: a status-only build allocates no key string.
    const terminalKey: unknown[] = [
      generation?.history,
      generation?.principals,
      this.deps.pairingGeneration(),
      peerFingerprint
    ]
    for (const p of panes.values()) {
      terminalKey.push(
        p.paneKey,
        p.worktreeId,
        p.handle,
        p.processIncarnation,
        p.hostScope,
        p.launchTokenHash,
        p.original
      )
    }
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
      this.chats = readAgentSenderSessions(records, this.work)
      this.chatKey = chatKey
    }
    try {
      if (terminalChanged) {
        this.readTerminals(db, generation?.principals ?? '', panes, terminalKey)
      }
    } finally {
      // A failed terminal read still publishes the chats read with it, beside the last good
      // terminal rows; publishing unchanged rows moves no revision.
      if (terminalChanged || chatsChanged) {
        this.publisher.publish({
          associations: [...this.terminal.associations, ...this.chats],
          principals: db ? this.principals : [],
          attachments: this.terminal.attachments,
          ...(peerFingerprint ? { peerFingerprint } : {})
        })
      }
    }
  }

  private readTerminals(
    db: OrchestrationDb | null,
    principalsGeneration: string,
    panes: Map<string, AgentSenderPane & { original: boolean }>,
    key: unknown[]
  ): void {
    let read: AgentSenderWorkers = { workers: [], remote: [] }
    try {
      if (db) {
        this.historyReads++
        read = this.workerHistory.read(db, [...panes.values()], this.work)
        // Federated Dispatches and pairings name principals; worker writes never reread them.
        const pairing = this.deps.pairingGeneration()
        if (principalsGeneration !== this.principalsRead || pairing !== this.pairing) {
          this.principals = readAgentSenderPrincipals(db, this.deps.principal)
          this.principalsRead = principalsGeneration
          this.pairing = pairing
        }
      }
    } catch (error) {
      // The next identity change retries.
      this.failedKey = key
      throw error
    }
    this.terminalKey = key
    this.failedKey = []
    const rows = new Map<string, AgentSenderAssociation>()
    const add = (identity: string, paneKey: string, dispatchActor?: true) => {
      const pane = panes.get(paneKey)
      // A live handle names its own pane before any worker lineage that once used it.
      if (pane && !rows.has(identity)) {
        rows.set(identity, {
          identity,
          paneKey,
          worktreeId: pane.worktreeId,
          ...(dispatchActor ? { dispatchActor } : {})
        })
      }
    }
    for (const pane of panes.values()) {
      if (pane.original) {
        add(pane.handle, pane.paneKey)
      }
    }
    for (const worker of read.workers) {
      add(worker.identity, worker.paneKey, worker.dispatchActor)
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
}

function same(key: unknown[], other: unknown[]): boolean {
  return key.length === other.length && key.every((value, i) => value === other[i])
}
