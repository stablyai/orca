import { AgentSenderHandleIncarnations } from './agent-sender-handle-incarnations'
import type { Dependencies } from './runtime-agent-sender-dependencies'
export {
  type AgentSenderHandleReads,
  type TerminalHandleAccess
} from './runtime-agent-sender-dependencies'
import type {
  AgentSenderAssociation,
  AgentSenderPublication,
  AgentSenderRevision
} from '../../../shared/agent-sender-associations'

import { readLiveAgentSenderPanes, type AgentSenderPane } from './agent-sender-live-panes'
import { prepareAgentSenderPrincipals, type AgentSenderPrincipal } from './agent-sender-principals'
import { readAgentSenderSessions } from './agent-sender-chat-sessions'
import {
  AgentSenderWorkerHistory,
  type AgentSenderWorkers
} from './runtime-agent-sender-worker-history'
import { readAgentSenderGeneration } from './runtime-agent-sender-history-triggers'
import type { OrchestrationDb } from '../orchestration/db/orchestration-db'

import {
  AgentSenderPublisher,
  sameAgentSenderKey as same,
  type AgentSenderScope
} from './runtime-agent-sender-publication'

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
  private readonly handleIncarnations = new AgentSenderHandleIncarnations()
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

  private publicationTail: Promise<void> = Promise.resolve()
  private preparedPrincipals: { values: AgentSenderPrincipal[] } | { error: unknown } | undefined

  /** Preparation may yield; the consumer owns a complete synchronous publication and delivery. */
  withPreparedPublication<T>(
    consume: () => T extends PromiseLike<unknown> ? never : T,
    prepare = true
  ): Promise<T> {
    const result = this.publicationTail.then(async () => {
      if (prepare) {
        try {
          for (;;) {
            const prepared = await prepareAgentSenderPrincipals(this.deps, {
              db: this.database,
              generation: this.principalsRead,
              pairing: this.pairing,
              values: this.principals
            })
            if (prepared.current()) {
              this.preparedPrincipals = { values: prepared.values }
              break
            }
          }
        } catch (error) {
          this.preparedPrincipals = { error }
        }
      }
      try {
        return consume()
      } finally {
        this.preparedPrincipals = undefined
      }
    })
    this.publicationTail = result.then(
      () => {},
      () => {}
    )
    return result
  }

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
      this.handleIncarnations.matches(handle, incarnation)
    )
  }

  /** A handle names the execution it was issued to; restart reattach keeps both, but a respawn
   *  that kept the handle runs a fresh shell, so its old cards no longer name what runs there. */

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
          const prepared = this.preparedPrincipals
          if (!prepared) {
            throw new Error('Sender publication requires prepared principals')
          }
          if ('error' in prepared) {
            throw prepared.error
          }
          this.principals = prepared.values
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
