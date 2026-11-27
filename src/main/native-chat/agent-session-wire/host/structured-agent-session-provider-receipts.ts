import { randomUUID } from 'node:crypto'
import { AGENT_SESSION_ID_MAX_LENGTH } from '../../../../shared/agent-session/agent-session-wire'
import type { ProviderReceiptUpdate } from '../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import type { JournalHandoverIdentity } from '../../agent-session-journal/journal-store-contracts'
import type { JournalWriterCommit } from '../../agent-session-journal/journal-writer-changes'
import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import { MAX_ACTIVE_DISPATCH_WAITERS } from '../../../claude/structured/dispatch/claude-structured-dispatch-waiters'
import { MAX_CODEX_PENDING_DISPATCH_ECHOES } from '../../../codex/structured/turns/codex-dispatch-receipt-correlation'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild
} from './structured-agent-session-host-types'
import { sameProviderChild } from './structured-agent-session-provider-child'

export type ProviderReceiptHandover = JournalHandoverIdentity & {
  clientMessageId: string
  fence: number
}

export type ProviderReceiptObservation = ProviderReceiptHandover & { observedAt: number }

type Receipt = JournalHandoverIdentity & { stamp?: ProviderReceiptUpdate }
type LiveHandovers = {
  journal: SqlAgentSessionJournal
  child: StructuredAgentSessionProviderChild
  epoch: string
  publicEpoch: string
  stamps: number
  entries: Map<string, Receipt>
}

export const MAX_HOST_PROVIDER_RECEIPTS = 4096
const EMPTY: readonly never[] = []
type ReceiptObserver = (clientMessageId: string | null, closed?: true) => void

export class StructuredAgentSessionProviderReceipts {
  readonly incarnation = randomUUID()
  private entries = 0
  private readonly live = new Map<string, LiveHandovers>()
  private readonly observers = new Map<string, Set<ReceiptObserver>>()
  private stopped = false

  get closed(): boolean {
    return this.stopped
  }

  constructor(
    private readonly session: (sessionId: string) => StructuredAgentSessionHostSession | undefined,
    private readonly currentFence: (sessionId: string) => number | undefined
  ) {}

  register(
    sessionId: string,
    journal: SqlAgentSessionJournal,
    child: StructuredAgentSessionProviderChild,
    clientMessageId: string,
    handover: JournalHandoverIdentity | undefined
  ): void {
    this.revalidate(sessionId)
    const current = this.live.get(sessionId)?.entries.get(clientMessageId)
    if (
      current &&
      handover &&
      current.attempt === handover.attempt &&
      current.handoverCursor.sequence === handover.handoverCursor.sequence &&
      current.handoverCursor.epoch === handover.handoverCursor.epoch
    ) {
      return
    }
    this.supersede(sessionId, journal, clientMessageId)
    const session = this.session(sessionId)
    const agent = session?.params.agent
    const cap =
      agent === 'claude'
        ? MAX_ACTIVE_DISPATCH_WAITERS
        : agent === 'codex'
          ? MAX_CODEX_PENDING_DISPATCH_ECHOES
          : 0
    if (
      this.closed ||
      !handover ||
      !cap ||
      this.entries >= MAX_HOST_PROVIDER_RECEIPTS ||
      sessionId.length > AGENT_SESSION_ID_MAX_LENGTH ||
      clientMessageId.length > AGENT_SESSION_ID_MAX_LENGTH ||
      handover.handoverCursor.epoch.length > AGENT_SESSION_ID_MAX_LENGTH ||
      !this.owns(session, journal, child, handover.handoverCursor.epoch)
    ) {
      return
    }
    let live = this.live.get(sessionId)
    if (!live) {
      live = {
        journal,
        child,
        epoch: handover.handoverCursor.epoch,
        publicEpoch: journal.cursor().epoch,
        stamps: 0,
        entries: new Map()
      }
      this.live.set(sessionId, live)
    }
    if (live.entries.size < cap) {
      live.entries.set(clientMessageId, {
        attempt: handover.attempt,
        handoverCursor: handover.handoverCursor
      })
      this.entries++
    }
  }

  stamp(
    sessionId: string,
    child: StructuredAgentSessionProviderChild,
    observation: ProviderReceiptObservation
  ): void {
    const live = this.live.get(sessionId)
    if (!live || live.child !== child || child.fence !== observation.fence) {
      return
    }
    const receipt = live.entries.get(observation.clientMessageId)
    if (
      !receipt ||
      receipt.stamp !== undefined ||
      receipt.attempt !== observation.attempt ||
      receipt.handoverCursor.epoch !== observation.handoverCursor.epoch ||
      receipt.handoverCursor.sequence !== observation.handoverCursor.sequence ||
      !Number.isFinite(observation.observedAt) ||
      live.journal.cursor().epoch !== live.publicEpoch ||
      !this.owns(this.session(sessionId), live.journal, child, live.epoch)
    ) {
      return
    }
    receipt.stamp = {
      clientMessageId: observation.clientMessageId,
      attempt: observation.attempt,
      handoverSequence: observation.handoverCursor.sequence,
      fence: observation.fence,
      observedAt: observation.observedAt
    }
    live.stamps++
    this.changed(sessionId, observation.clientMessageId)
  }

  withdraw(
    sessionId: string,
    child: StructuredAgentSessionProviderChild,
    handover: ProviderReceiptHandover
  ): void {
    const live = this.live.get(sessionId)
    const current = live?.entries.get(handover.clientMessageId)
    if (
      live?.child === child &&
      child.fence === handover.fence &&
      current?.attempt === handover.attempt &&
      current.handoverCursor.epoch === handover.handoverCursor.epoch &&
      current.handoverCursor.sequence === handover.handoverCursor.sequence
    ) {
      this.supersede(sessionId, live.journal, handover.clientMessageId)
    }
  }

  committed(sessionId: string, journal: SqlAgentSessionJournal, commit: JournalWriterCommit): void {
    if (!this.live.has(sessionId)) {
      return
    }
    if (commit.publication?.resetPrompts) {
      this.retire(sessionId)
      return
    }
    this.revalidate(sessionId)
    const publication = commit.publication
    for (const dispatch of publication?.promptDispatches ?? EMPTY) {
      if (dispatch.state !== 'pending') {
        this.supersede(sessionId, journal, dispatch.clientMessageId)
      }
    }
    for (const receipt of publication?.receipts ?? EMPTY) {
      this.supersede(sessionId, journal, receipt.clientMessageId)
    }
  }

  retire(sessionId: string): void {
    const live = this.live.get(sessionId)
    if (live) {
      this.entries -= live.entries.size
      this.live.delete(sessionId)
      if (live.stamps) {
        this.changed(sessionId, null)
      }
    }
  }

  revalidate(sessionId: string): void {
    const live = this.live.get(sessionId)
    if (
      live &&
      (live.journal.cursor().epoch !== live.publicEpoch ||
        !this.owns(this.session(sessionId), live.journal, live.child, live.epoch))
    ) {
      this.retire(sessionId)
    }
  }

  watch(sessionId: string, observe: ReceiptObserver): () => void {
    const observers = this.observers.get(sessionId) ?? new Set()
    observers.add(observe)
    this.observers.set(sessionId, observers)
    return () => {
      observers.delete(observe)
      if (observers.size === 0 && this.observers.get(sessionId) === observers) {
        this.observers.delete(sessionId)
      }
    }
  }

  stampFor(sessionId: string, clientMessageId: string): ProviderReceiptUpdate | undefined {
    return this.live.get(sessionId)?.entries.get(clientMessageId)?.stamp
  }

  *snapshot(sessionId: string): IterableIterator<ProviderReceiptUpdate> {
    for (const receipt of this.live.get(sessionId)?.entries.values() ?? EMPTY) {
      if (receipt.stamp) {
        yield receipt.stamp
      }
    }
  }

  close(): void {
    this.stopped = true
    this.live.clear()
    this.entries = 0
    for (const observers of this.observers.values()) {
      for (const observe of observers) {
        observe(null, true)
      }
    }
    this.observers.clear()
  }

  private supersede(
    sessionId: string,
    journal: SqlAgentSessionJournal,
    clientMessageId: string
  ): void {
    const live = this.live.get(sessionId)
    const receipt = live?.entries.get(clientMessageId)
    if (!receipt || live?.journal !== journal) {
      return
    }
    live.entries.delete(clientMessageId)
    this.entries--
    if (live.entries.size === 0) {
      this.live.delete(sessionId)
    }
    if (receipt.stamp !== undefined) {
      live.stamps--
      this.changed(sessionId, clientMessageId)
    }
  }

  private owns(
    session: StructuredAgentSessionHostSession | undefined,
    journal: SqlAgentSessionJournal,
    child: StructuredAgentSessionProviderChild,
    epoch: string
  ): boolean {
    return (
      session?.journal === journal &&
      session.child === child &&
      !child.close &&
      !(session.lastEndedChild && sameProviderChild(child, session.lastEndedChild)) &&
      !journal.isClosed &&
      journal.physicalCursor().epoch === epoch &&
      this.currentFence(journal.identity.sessionId) === child.fence
    )
  }

  private changed(sessionId: string, clientMessageId: string | null): void {
    for (const observe of this.observers.get(sessionId) ?? EMPTY) {
      observe(clientMessageId)
    }
  }
}
