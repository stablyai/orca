import type {
  AgentSenderAssociation,
  AgentSenderPublication,
  AgentSenderRevision
} from '../../shared/agent-sender-associations'
import {
  readAgentSenderPrincipals,
  readAgentSenderSessions,
  type AgentSenderPane,
  type AgentSenderPrincipal
} from './runtime-agent-sender-history'
import {
  AgentSenderWorkerHistory,
  type AgentSenderWorkers
} from './runtime-agent-sender-worker-history'
import { AgentSenderLivePanes } from './runtime-agent-sender-panes'
import type { OrchestrationDb } from './orchestration/db'
import { AgentSenderPublisher, type AgentSenderScope } from './runtime-agent-sender-publication'

export type { AgentSenderHandleReads, TerminalHandleAccess } from './runtime-agent-sender-panes'
import {
  captureAgentSenderInput,
  sameAgentSenderInput as same,
  type AgentSenderDependencies
} from './runtime-agent-sender-input'

type SenderPass = {
  publication: AgentSenderPublication
  scope: (worktreeId: string) => AgentSenderPublication
  frame: (worktreeId: string) => AgentSenderPublication
}
type TerminalSenders = Pick<AgentSenderScope, 'associations' | 'attachments'>

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
  private readonly panes: AgentSenderLivePanes
  private terminalKey: unknown[] = []
  private failedKey: unknown[] = []
  private terminal: TerminalSenders = { associations: [], attachments: [] }
  private chatKey: unknown[] = []
  private chats: AgentSenderAssociation[] = []
  private refreshing?: { key: unknown[]; result: Promise<SenderPass>; terminalChanged: boolean }
  private nextRefresh?: Promise<SenderPass>
  private releaseWhenSettled = false
  readonly publisher = new AgentSenderPublisher((id) => this.deps.hasPublishedScope?.(id) ?? false)
  constructor(
    private readonly deps: AgentSenderDependencies,
    private readonly captureChatDelivery: () => { key: unknown[]; publish: () => void } = () => ({
      key: [],
      publish: () => {}
    })
  ) {
    this.panes = new AgentSenderLivePanes(deps, this.work)
  }

  /** Display bookkeeping: a failure keeps the last good publication and never fails a caller. */
  async build(worktreeId?: string): Promise<AgentSenderPublication> {
    try {
      const pass = await this.refresh()
      return worktreeId ? pass.scope(worktreeId) : pass.publication
    } catch {}
    return worktreeId ? this.publisher.scope(worktreeId) : this.publisher.current()
  }

  /** A window graph reply carries the rows only when the window's applied base is stale. */
  async buildForGraph(base: AgentSenderRevision | undefined) {
    return this.publisher.forGraph(base, await this.build())
  }

  /** The scope a client frame carries; remembered so a refresh republishes only changed worktrees. */
  async buildForFrame(worktreeId: string): Promise<AgentSenderPublication> {
    return (await this.buildForFramePass())(worktreeId)
  }

  /** One refresh for a synchronous pass that frames many worktrees: each reads that one result. */
  async buildForFramePass(): Promise<(worktreeId: string) => AgentSenderPublication> {
    try {
      return (await this.refresh()).frame
    } catch {
      return this.publisher.captureFramePass()
    }
  }

  /** Structural delivery owns its callback; only chat lineage continues in the native flight. */
  immediateFramePass(): (worktreeId: string) => AgentSenderPublication {
    try {
      void this.refresh()
    } catch (error) {
      console.warn('[runtime] Sender identity publication failed', error)
    }
    return this.publisher.captureFramePass()
  }

  acknowledgeFrame(worktreeId: string, scope: AgentSenderPublication): void {
    this.publisher.acknowledgeFrame(worktreeId, scope)
  }

  retireScope(worktreeId: string): void {
    this.publisher.retireScope(worktreeId)
  }

  releaseDerivedHistory(): void {
    if (this.refreshing || this.nextRefresh) {
      this.releaseWhenSettled = true
      return
    }
    this.releaseWhenSettled = false
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
  async changedScopes(worktreeIds: Iterable<string>): Promise<string[]> {
    await this.build()
    return this.publisher.changedScopes(worktreeIds)
  }

  private capture() {
    return captureAgentSenderInput(this.deps, this.panes, this.database)
  }

  private refresh(): Promise<SenderPass> {
    const input = this.capture()
    const beforeTerminal = this.publisher.current()
    this.refreshTerminals(input)
    const terminalChanged = beforeTerminal !== this.publisher.current()
    const delivery = this.captureChatDelivery()
    const key = [input.db, ...input.chatKey, ...delivery.key]
    if (this.refreshing) {
      this.refreshing.terminalChanged ||= terminalChanged
      if (same(key, this.refreshing.key)) {
        return this.refreshing.result
      }
      this.nextRefresh ??= this.refreshing.result
        .catch(() => {})
        .then(() => {
          this.nextRefresh = undefined
          return this.refresh()
        })
      return this.nextRefresh
    }
    const result = this.runRefresh(input)
      .then(
        (changed) => {
          const lifetimeChanged = !same(delivery.key, this.chatKey.slice(2))
          const pass = {
            publication: this.publisher.current(),
            scope: this.publisher.captureScopes(),
            frame: this.publisher.captureFramePass()
          }
          if (changed || this.refreshing?.terminalChanged || lifetimeChanged) {
            delivery.publish()
          }
          this.chatKey = [...this.chatKey.slice(0, 2), ...delivery.key]
          return pass
        },
        (error: unknown) => {
          if (this.refreshing?.terminalChanged) {
            delivery.publish()
          }
          throw error
        }
      )
      .finally(() => {
        this.refreshing = undefined
        if (this.releaseWhenSettled && !this.nextRefresh) {
          this.releaseDerivedHistory()
        }
      })
    this.refreshing = { key, result, terminalChanged }
    void result.catch((error: unknown) => {
      console.warn('[runtime] Sender identity publication failed', error)
    })
    return result
  }

  private refreshTerminals(input: ReturnType<RuntimeAgentSenderAssociations['capture']>): void {
    const { db, install, generation, panes, peerFingerprint, terminalKey } = input
    if (install) {
      this.database = db
      this.workerHistory = new AgentSenderWorkerHistory()
      this.principalsRead = ''
      this.principals = []
      this.terminalKey = []
      this.failedKey = []
    }
    if (same(terminalKey, this.terminalKey) || same(terminalKey, this.failedKey)) {
      return
    }
    try {
      this.readTerminals(db, generation?.principals ?? '', panes, terminalKey)
      this.publish(peerFingerprint)
    } catch (error) {
      console.warn('[runtime] Sender identity publication failed', error)
    }
  }

  private async runRefresh(
    input: ReturnType<RuntimeAgentSenderAssociations['capture']>
  ): Promise<boolean> {
    const { db, records } = input
    let { chatKey } = input
    if (same(chatKey, this.chatKey.slice(0, 2))) {
      return false
    }
    this.chatReads++
    const snapshot = await records?.senderSnapshot?.()
    let chats: AgentSenderAssociation[]
    try {
      chats = await readAgentSenderSessions(snapshot?.records ?? records, this.work)
      if (snapshot) {
        chatKey = [records?.listRecords, snapshot.revision]
      }
    } finally {
      await snapshot?.close()
    }
    if (
      this.deps.getSessionRecords()?.listRecords !== records?.listRecords ||
      this.deps.getDb() !== db
    ) {
      return false
    }
    this.chats = chats
    this.chatKey = chatKey
    const before = this.publisher.current()
    this.publish(this.publisher.current().peerFingerprint)
    return before !== this.publisher.current()
  }

  private publish(peerFingerprint: string | undefined): void {
    this.publisher.publish({
      associations: [...this.terminal.associations, ...this.chats],
      principals: this.database ? this.principals : [],
      attachments: this.terminal.attachments,
      ...(peerFingerprint ? { peerFingerprint } : {})
    })
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
}
