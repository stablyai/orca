import type {
  ProviderRelayKeepSpec,
  ProviderRelayKeptLine,
  ProviderRelayOutstandingRequest,
  ProviderRelayRecord
} from '../protocol/daemon-provider-relay-protocol'
import { readProviderRelayKeepSpec } from './provider-relay-keep-spec'

/** Kept lines share the record's memory budget with held requests; past these one is dropped. */
const MAX_KEPT_LINE_CHARS = 1024 * 1024
const MAX_KEPT_CHARS = 2 * 1024 * 1024
/** Markers name a message kind, which comes before its payload; only a bounded head is scanned. */
const MARKER_SCAN_CHARS = 64 * 1024
/** Client requests awaited for keeping or listing; a client that never gets answers can't grow the map. */
const MAX_AWAITED_REQUESTS = 64

/** `since`: the last agent line's seq when the request was written. */
type AwaitedRequest = ProviderRelayOutstandingRequest & {
  keep: boolean
  outstanding: boolean
  since: number
}
type AnsweredRequest = ProviderRelayOutstandingRequest & { seq: number; since: number }

function commonPrefix(values: readonly string[]): string {
  let prefix = values[0] ?? ''
  for (const value of values) {
    while (!value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1)
    }
  }
  return prefix
}

/**
 * Session state a relay keeps for the next attach, as `relaySpawn` named it: the latest answer to
 * each named client request, the latest agent line matching each marker, and the named requests
 * still unanswered (or answered within the next replay). It outlives the agent's exit, so an
 * agent that ended while no app was attached still opens and hands its last output on.
 */
export class ProviderRelayKeptState {
  private spec: ProviderRelayKeepSpec | null = null
  /** What every marker starts with: a line is searched once for it, not once per marker. */
  private markerPrefix = ''
  /** Client requests named by the keep spec, by key, until answered. */
  private readonly awaited = new Map<string, AwaitedRequest>()
  /** Per outstanding-tracked method, the latest one answered and the seq of its answer. */
  private readonly answered = new Map<string, AnsweredRequest>()
  /** `a:<method>` or `l:<marker>` → the latest line for it. */
  private readonly kept = new Map<string, ProviderRelayRecord>()
  chars = 0
  private lastAgentSeq = 0
  /** The attaching app asked for kept lines (its first reattach); any other attach drops them. */
  sendOnAttach = false

  configure(spec: unknown): void {
    this.spec = readProviderRelayKeepSpec(spec)
    this.markerPrefix = commonPrefix(this.spec?.lines ?? [])
  }

  /** An answer this state waits for may be on any line. */
  get awaiting(): boolean {
    return this.awaited.size > 0
  }

  /** Kept lines in seq order, sent on attach before held requests. */
  records(): ProviderRelayRecord[] {
    return this.sendOnAttach ? [...this.kept.values()].sort((a, b) => a.seq - b.seq) : []
  }

  /** Which kept seq answers to which name, and requests the agent still owes or answered after
   *  `afterSeq` (so the answer is in this replay), oldest first; empty ones are left out. A request
   *  whose every line is in the replay says so: a replayed turn then reads as the live one did. */
  attachDetails(afterSeq: number): {
    kept?: ProviderRelayKeptLine[]
    outstanding?: ProviderRelayOutstandingRequest[]
  } {
    const kept = this.sendOnAttach
      ? [...this.kept].map(([name, record]) => ({ seq: record.seq, name }))
      : []
    const outstanding = [
      ...[...this.answered.values()]
        .filter((request) => request.seq > afterSeq)
        .map(({ id, method, since }) => ({
          id,
          method,
          answered: true as const,
          ...(since >= afterSeq ? { replayedWhole: true as const } : {})
        })),
      ...[...this.awaited.values()]
        .filter((request) => request.outstanding)
        .map(({ id, method, since }) => ({
          id,
          method,
          ...(since >= afterSeq ? { replayedWhole: true as const } : {})
        }))
    ]
    return {
      ...(kept.length > 0 ? { kept } : {}),
      ...(outstanding.length > 0 ? { outstanding } : {})
    }
  }

  /** Keeps the line under each marker it names. */
  observeAgentLine(record: ProviderRelayRecord): void {
    this.lastAgentSeq = record.seq
    if (!this.spec || this.spec.lines.length === 0) {
      return
    }
    const { line } = record
    const head = line.length > MARKER_SCAN_CHARS ? line.slice(0, MARKER_SCAN_CHARS) : line
    const { lines } = this.spec
    const prefix = this.markerPrefix
    if (!prefix) {
      lines.filter((marker) => head.includes(marker)).forEach((marker) => this.keep(marker, record))
      return
    }
    for (let at = head.indexOf(prefix); at !== -1; at = head.indexOf(prefix, at + 1)) {
      lines.filter((marker) => head.startsWith(marker, at)).forEach((m) => this.keep(m, record))
    }
  }

  /** A client request the spec names, awaited by its id key. */
  observeRequest(key: string | null, id: unknown, method: string): void {
    const keep = this.spec?.answers.includes(method) === true
    const outstanding = this.spec?.outstanding.includes(method) === true
    if (!key || (!keep && !outstanding) || (typeof id !== 'number' && typeof id !== 'string')) {
      return
    }
    if (this.awaited.size >= MAX_AWAITED_REQUESTS) {
      const oldest = this.awaited.keys().next().value
      if (oldest !== undefined) {
        this.awaited.delete(oldest)
      }
    }
    this.awaited.set(key, { id, method, keep, outstanding, since: this.lastAgentSeq })
  }

  /** An awaited request's answer: the latest success is kept, a listed one noted answered. */
  observeAnswer(key: string, succeeded: boolean, record: ProviderRelayRecord): void {
    const awaited = this.awaited.get(key)
    if (!awaited) {
      return
    }
    this.awaited.delete(key)
    if (awaited.outstanding) {
      const { id, method, since } = awaited
      this.answered.set(method, { id, method, seq: record.seq, since })
    }
    // Only a success is state worth restoring; a refused request leaves the last one standing.
    if (awaited.keep && succeeded) {
      this.keepLine(`a:${awaited.method}`, record)
    }
  }

  private keep(marker: string, record: ProviderRelayRecord): void {
    this.keepLine(`l:${marker}`, record)
  }

  private keepLine(name: string, record: ProviderRelayRecord): void {
    const previous = this.kept.get(name)
    if (previous) {
      this.kept.delete(name)
      this.chars -= previous.line.length
    }
    // A line too large to keep drops the stale one: an older state is worse than none.
    if (
      record.line.length > MAX_KEPT_LINE_CHARS ||
      this.chars + record.line.length > MAX_KEPT_CHARS
    ) {
      return
    }
    this.kept.set(name, record)
    this.chars += record.line.length
  }
}
