import { randomUUID } from 'node:crypto'
import type { ProviderReceiptUpdate } from '../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import type { JournalHandoverIdentity } from '../../agent-session-journal/journal-store-contracts'
import type { JournalWriterCommit } from '../../agent-session-journal/journal-writer-changes'
import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import { MAX_ACTIVE_DISPATCH_WAITERS } from '../../../claude/structured/dispatch/claude-structured-dispatch-waiters'
import { MAX_CODEX_PENDING_DISPATCH_ECHOES } from '../../../codex/structured/turns/codex-dispatch-receipt-correlation'
import {
  AgentSessionReceiptStream,
  MAX_PROVIDER_RECEIPT_FRAME_BYTES,
  MAX_PROVIDER_RECEIPT_KEY_LENGTH,
  MAX_PROVIDER_RECEIPT_STREAMS,
  type ProviderReceiptEmitter
} from '../publication/subscribers/agent-session-subscriber-receipts'
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

type Receipt = JournalHandoverIdentity & { observedAt?: number }
type LiveHandovers = {
  journal: SqlAgentSessionJournal
  child: StructuredAgentSessionProviderChild
  epoch: string
  publicEpoch: string
  stamps: number
  entries: Map<string, Receipt>
}

// 4,096 entries at a budget of 1 KiB each (including the key and map accounting), plus at most
// 256 streams holding two 224 KiB buffers each. IDs/metadata are capped; no carrier or content is
// retained. Journal and child references point to authority already held by the conversation.
export const MAX_HOST_PROVIDER_RECEIPTS = 4096
export const MAX_HOST_PROVIDER_RECEIPT_BYTES =
  MAX_HOST_PROVIDER_RECEIPTS * 1024 +
  2 * MAX_PROVIDER_RECEIPT_STREAMS * MAX_PROVIDER_RECEIPT_FRAME_BYTES
const EMPTY: readonly never[] = []

export class StructuredAgentSessionProviderReceipts {
  private readonly incarnation = randomUUID()
  private revision = 0
  private entries = 0
  private streams = 0
  private closed = false
  private readonly live = new Map<string, LiveHandovers>()
  private readonly subscribers = new Map<string, Set<AgentSessionReceiptStream>>()

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
      sessionId.length > MAX_PROVIDER_RECEIPT_KEY_LENGTH ||
      clientMessageId.length > MAX_PROVIDER_RECEIPT_KEY_LENGTH ||
      handover.handoverCursor.epoch.length > MAX_PROVIDER_RECEIPT_KEY_LENGTH ||
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
      receipt.observedAt !== undefined ||
      receipt.attempt !== observation.attempt ||
      receipt.handoverCursor.epoch !== observation.handoverCursor.epoch ||
      receipt.handoverCursor.sequence !== observation.handoverCursor.sequence ||
      !Number.isFinite(observation.observedAt) ||
      live.journal.cursor().epoch !== live.publicEpoch ||
      !this.owns(this.session(sessionId), live.journal, child, live.epoch)
    ) {
      return
    }
    receipt.observedAt = observation.observedAt
    live.stamps++
    this.changed(sessionId, observation.clientMessageId, receipt.observedAt)
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
      if (live.stamps > 0) {
        this.revision++
        for (const stream of this.subscribers.get(sessionId) ?? EMPTY) {
          stream.reset()
        }
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

  subscribe(sessionId: string, emit: ProviderReceiptEmitter) {
    if (
      this.closed ||
      this.streams >= MAX_PROVIDER_RECEIPT_STREAMS ||
      sessionId.length > MAX_PROVIDER_RECEIPT_KEY_LENGTH
    ) {
      return undefined
    }
    const stream = new AgentSessionReceiptStream(sessionId, this.incarnation, emit, () => {
      this.revalidate(sessionId)
      return { revision: this.revision, snapshot: () => this.snapshot(sessionId) }
    })
    const streams = this.subscribers.get(sessionId) ?? new Set()
    streams.add(stream)
    this.subscribers.set(sessionId, streams)
    this.streams++
    return {
      open: () => stream.open(),
      close: () => {
        if (streams.delete(stream)) {
          this.streams--
          if (streams.size === 0) {
            this.subscribers.delete(sessionId)
          }
        }
        stream.close()
      }
    }
  }

  close(): void {
    this.closed = true
    this.live.clear()
    this.entries = 0
    for (const streams of this.subscribers.values()) {
      for (const stream of streams) {
        stream.close()
      }
      streams.clear()
    }
    this.subscribers.clear()
    this.streams = 0
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
    if (receipt.observedAt !== undefined) {
      live.stamps--
      this.changed(sessionId, clientMessageId, null)
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

  private changed(sessionId: string, clientMessageId: string, observedAt: number | null): void {
    this.revision++
    for (const stream of this.subscribers.get(sessionId) ?? EMPTY) {
      stream.changed(clientMessageId, observedAt)
    }
  }

  private snapshot(sessionId: string): ProviderReceiptUpdate[] {
    const updates: ProviderReceiptUpdate[] = []
    for (const [clientMessageId, receipt] of this.live.get(sessionId)?.entries ?? EMPTY) {
      if (receipt.observedAt !== undefined) {
        updates.push({ clientMessageId, observedAt: receipt.observedAt })
      }
    }
    return updates
  }
}
