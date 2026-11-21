// What each connector snapshot said and what became of it, as trace spans: why it was taken, what it
// sent or left out, and the request the cloud took it under. Prompt text never appears.
import { randomUUID } from 'node:crypto'
import {
  CONNECTOR_CLIENT_LIMITS,
  type ConnectorEvent
} from '../../shared/connectors/connector-cloud-contract'
import type { ConversationSnapshot } from '../external-conversations/external-conversation-events'
import { startSpan } from '../observability/tracer'
import type { ConnectorStamp } from './connector-outbox'
import type { ConnectorCallObserver } from './connector-transport'
import { builtCounts, type ConnectorSnapshotWire } from './connector-snapshot-built'

/** Why a client took the snapshot: the watch before its first hello, or what made it say hello. */
export type ConnectorSnapshotReason =
  | 'client-start'
  | 'first'
  | 'inputs-changed'
  | 'features-changed'
  | 'poll-409'
  | 'poll-409-features'
  | 'poll-failed'
  | 'post-409'
  | 'silence'
  | 'dropped-events'

export type ConnectorSnapshotExpectation = {
  reason: ConnectorSnapshotReason
  clientId: string
  /** The hello the snapshot is meant to open; its accepted stamp is what counts. */
  intendedHelloRev: number | null
}

/** One poll client's part of its snapshots' traces: who it is, and why its next hello is owed. */
export class ConnectorClientSnapshots {
  readonly clientId = randomUUID().slice(0, 8)
  private owed: ConnectorSnapshotReason = 'first'

  // Read when used: the client's events are set after this is built.
  constructor(
    private readonly events: () => {
      expectSnapshot(expectation: ConnectorSnapshotExpectation): void
      readonly needsSnapshot: boolean
    }
  ) {}

  /** The current hello was dropped, so the next one is owed for `reason`; returns no revision. */
  drop(reason: ConnectorSnapshotReason): null {
    this.owed = reason
    return null
  }

  /**
   * Said before the watch whose snapshot opens hello `rev`'s events, or the client's first watch (no
   * hello). `again` is false for the re-hello an answer's features asked for; `current` whether a hello
   * was still current when this one was said.
   */
  expect(hello?: ConnectorClientHello): void {
    const reason: ConnectorSnapshotReason = !hello
      ? 'client-start'
      : !hello.again
        ? 'features-changed'
        : !hello.current
          ? this.owed
          : this.events().needsSnapshot
            ? 'dropped-events'
            : 'inputs-changed'
    if (hello) {
      this.owed = 'first'
    }
    this.events().expectSnapshot({
      reason,
      clientId: this.clientId,
      intendedHelloRev: hello?.rev ?? null
    })
  }
}

export type ConnectorClientHello = {
  rev: number
  again: boolean
  current: boolean
}

export type ConnectorSnapshotTraceSink = (name: string, attributes: Record<string, unknown>) => void

const spanSink: ConnectorSnapshotTraceSink = (name, attributes) => {
  startSpan(name, { attributes }).end()
}

// requestConnector always settles by its timeout or the client's abort; this is the backstop.
const SETTLE_DEADLINE_MS = 2 * CONNECTOR_CLIENT_LIMITS.pollTimeoutMs
let nextSnapshotId = 0

type Outcome = 'accepted' | 'superseded' | 'never-sent' | 'dropped'

type SnapshotMeta = ConnectorSnapshotExpectation & {
  snapshotId: number
  stamps: ConnectorStamp[]
  httpRequests: number
  authRetries: number
  tokenFailures: number
  refusedSplits: number
  callsInFlight: number
  requestsInFlight: number
  lastStatus: number | 'network' | 'aborted' | null
  lateApplied: boolean
  outcome: { kind: Outcome; stamp: ConnectorStamp | null } | null
  emitted: boolean
  deadline: ReturnType<typeof setTimeout> | null
}

export class ConnectorSnapshotTrace {
  private readonly metas = new WeakMap<ConnectorEvent, SnapshotMeta>()
  // Snapshots whose single terminal span has not gone yet.
  private readonly pending = new Set<SnapshotMeta>()
  private expectation: ConnectorSnapshotExpectation | null = null
  private current: SnapshotMeta | null = null

  constructor(
    private readonly sink: ConnectorSnapshotTraceSink = spanSink,
    private readonly settleDeadlineMs = SETTLE_DEADLINE_MS
  ) {}

  /** Said just before a watch, whose snapshot arrives synchronously inside it. */
  expect(expectation: ConnectorSnapshotExpectation): void {
    this.expectation = expectation
  }

  /** The snapshot as built for the wire, after its caps; supersedes the one before it. */
  built(event: ConversationSnapshot, wire: ConnectorSnapshotWire): void {
    const expectation = this.expectation ?? {
      reason: 'first',
      clientId: 'unknown',
      intendedHelloRev: null
    }
    this.expectation = null
    if (this.current) {
      this.decide(this.current, this.current.stamps.length > 0 ? 'superseded' : 'never-sent', null)
    }
    const meta: SnapshotMeta = {
      ...expectation,
      snapshotId: ++nextSnapshotId,
      stamps: [],
      httpRequests: 0,
      authRetries: 0,
      tokenFailures: 0,
      refusedSplits: 0,
      callsInFlight: 0,
      requestsInFlight: 0,
      lastStatus: null,
      lateApplied: false,
      outcome: null,
      emitted: false,
      deadline: null
    }
    this.metas.set(wire.snapshot, meta)
    this.current = meta
    this.pending.add(meta)
    this.sink('connector.snapshot.built', {
      snapshotId: meta.snapshotId,
      clientId: meta.clientId,
      reason: meta.reason,
      intendedHelloRev: meta.intendedHelloRev,
      ...builtCounts(event, wire)
    })
  }

  stamped(batch: readonly ConnectorEvent[], stamp: ConnectorStamp): void {
    this.metaIn(batch)?.stamps.push(stamp)
  }

  accepted(batch: readonly ConnectorEvent[], stamp: ConnectorStamp): void {
    const meta = this.metaIn(batch)
    if (meta) {
      this.decide(meta, 'accepted', stamp)
    }
  }

  split(batch: readonly ConnectorEvent[]): void {
    const meta = this.metaIn(batch)
    if (meta && !meta.emitted) {
      meta.refusedSplits += 1
    }
  }

  dropped(item: ConnectorEvent, stamp: ConnectorStamp): void {
    const meta = this.metas.get(item)
    if (meta) {
      this.decide(meta, 'dropped', stamp)
    }
  }

  /** Watches one events request carrying a snapshot; undefined for any other batch. */
  requestsFor(batch: readonly ConnectorEvent[]): ConnectorCallObserver | undefined {
    const meta = this.metaIn(batch)
    if (!meta) {
      return undefined
    }
    return {
      callStarted: () => {
        meta.callsInFlight += 1
      },
      callSettled: () => {
        meta.callsInFlight -= 1
        this.settleIfDone(meta)
      },
      requestStarted: (renewal) => {
        if (meta.emitted) {
          return
        }
        meta.httpRequests += 1
        meta.requestsInFlight += 1
        if (renewal) {
          meta.authRetries += 1
        }
      },
      requestSettled: (status) => {
        if (meta.emitted) {
          return
        }
        meta.requestsInFlight -= 1
        meta.lastStatus = status
        if (
          typeof status === 'number' &&
          status >= 200 &&
          status < 300 &&
          meta.outcome?.kind === 'superseded'
        ) {
          meta.lateApplied = true
        }
        this.settleIfDone(meta)
      },
      noRequest: () => {
        if (!meta.emitted) {
          meta.tokenFailures += 1
        }
      }
    }
  }

  /** The outbox was dropped (sign-out, another account): every open snapshot reports now. */
  flush(): void {
    if (this.current) {
      this.decide(this.current, this.current.stamps.length > 0 ? 'superseded' : 'never-sent', null)
    }
    for (const meta of this.pending) {
      if (meta.outcome) {
        this.emit(meta, false)
      }
    }
  }

  private metaIn(batch: readonly ConnectorEvent[]): SnapshotMeta | undefined {
    // A snapshot opens its hello's events, so it is the head's first item when present.
    const first = batch[0]
    return first?.kind === 'snapshot' ? this.metas.get(first) : undefined
  }

  /** Each snapshot is decided once; its span waits until no call carrying it is still running. */
  private decide(meta: SnapshotMeta, kind: Outcome, stamp: ConnectorStamp | null): void {
    if (meta.outcome) {
      return
    }
    meta.outcome = { kind, stamp: stamp ?? meta.stamps.at(-1) ?? null }
    if (this.current === meta) {
      this.current = null
    }
    if (!this.settleIfDone(meta)) {
      meta.deadline = setTimeout(() => this.emit(meta, false), this.settleDeadlineMs)
      meta.deadline.unref?.()
    }
  }

  private settleIfDone(meta: SnapshotMeta): boolean {
    if (meta.emitted) {
      return true
    }
    if (!meta.outcome || meta.callsInFlight > 0 || meta.requestsInFlight > 0) {
      return false
    }
    this.emit(meta, true)
    return true
  }

  private emit(meta: SnapshotMeta, settled: boolean): void {
    if (meta.emitted || !meta.outcome) {
      return
    }
    meta.emitted = true
    if (meta.deadline) {
      clearTimeout(meta.deadline)
      meta.deadline = null
    }
    this.pending.delete(meta)
    const { stamp } = meta.outcome
    this.sink('connector.snapshot.sent', {
      snapshotId: meta.snapshotId,
      clientId: meta.clientId,
      reason: meta.reason,
      outcome: meta.outcome.kind,
      helloRev: stamp?.helloRev ?? null,
      seq: stamp?.seq ?? null,
      intendedHelloRev: meta.intendedHelloRev,
      stampsMinted: meta.stamps.length,
      httpRequests: meta.httpRequests,
      authRetries: meta.authRetries,
      credentialMintFailures: meta.tokenFailures,
      refusedSplits: meta.refusedSplits,
      lastStatus: meta.lastStatus,
      settled,
      inFlight: meta.requestsInFlight,
      callsInFlight: meta.callsInFlight,
      lateApplied: meta.lateApplied
    })
  }
}
