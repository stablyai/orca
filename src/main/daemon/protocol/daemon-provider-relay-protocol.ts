// Frozen relay RPC set: newer apps must be able to drive a daemon of this version unchanged.
export const PROVIDER_RELAY_PROTOCOL_VERSION = 63

export type ProviderRelayCapability = 'providerRelay' | 'providerRelayKeep' | 'providerRelayAcks'

/**
 * The hello capabilities a relaying daemon of each protocol advertises. An app adopts any running
 * daemon of its own protocol, even one an older bundle started, so a new capability needs a
 * PROTOCOL_VERSION bump and a new row; a shipped row never changes. v63 bundles differ; its row is
 * the set all of them share.
 */
export const PROVIDER_RELAY_CAPABILITIES_BY_PROTOCOL: Readonly<
  Record<number, readonly ProviderRelayCapability[]>
> = {
  63: ['providerRelay'],
  64: ['providerRelay', 'providerRelayKeep', 'providerRelayAcks']
}

/** What a relaying daemon of this protocol advertises: its newest row at or below it. */
export function providerRelayCapabilities(
  protocolVersion: number
): readonly ProviderRelayCapability[] {
  let newest = 0
  for (const version of Object.keys(PROVIDER_RELAY_CAPABILITIES_BY_PROTOCOL).map(Number)) {
    if (version <= protocolVersion && version > newest) {
      newest = version
    }
  }
  return PROVIDER_RELAY_CAPABILITIES_BY_PROTOCOL[newest] ?? []
}

/** An agent launch the daemon owns; env is complete because the daemon's own env is not the app's. */
export type ProviderRelaySpawnSpec = {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /** The app's native provider owner; the daemon cannot resolve app resources itself. */
  ownerExecutable: string
  /**
   * The launching app's bundle. A daemon kept from an older bundle for its live sessions starts
   * relays for a newer app too, as it does terminals (the relay protocol matched at hello); the
   * agent runs through the app's own `ownerExecutable`. Older daemons refuse another bundle.
   */
  appVersion?: string
  entryPath?: string
}

export type ProviderRelayRequest =
  | {
      id: string
      type: 'relaySpawn'
      payload: {
        spec: ProviderRelaySpawnSpec
        chatKey: string
        /** Which agent integration runs here; a build that can't reattach it ends it at launch. */
        agent?: string
        policy?: ProviderRelayDetachPolicy
        /** Only sent to a daemon advertising `providerRelayKeep`; older ones ignore it. */
        keep?: ProviderRelayKeepSpec
      }
    }
  | {
      id: string
      type: 'relayAttach'
      payload: {
        relayId: string
        fromSeq: number
        policy?: ProviderRelayDetachPolicy
        /** Send the kept lines (`relayKept`): the app's first reattach is the one that reads them. */
        kept?: true
      }
    }
  /**
   * Must be a request, never a notification: a full agent input refuses it, and only a reply can say
   * so. Data over `RELAY_WRITE_CHUNK_CHARS` (a large image prompt) is sent as consecutive writes of
   * at most that many chars; the agent's stdin is a byte stream, so a line may span writes, and a
   * surrogate pair split between two writes is joined before it is encoded.
   */
  | { id: string; type: 'relayWrite'; payload: { relayId: string; data: string } }
  /**
   * The client received through `seq`. `keepFrom` (optional) is the first line it still needs after
   * a restart, such as the start of an open streamed item: memory is freed through `seq`, lines from
   * `keepFrom` on are kept in the spool file, and a later attach replays from there. A kept span
   * longer than the file cap is released through `seq` rather than stalling the agent. `cut` says
   * this ack gives up a kept span still open (through `seq`, or before `keepFrom` when it keeps
   * from a later line), so a later attach reports `truncatedThrough`. `held` marks the kept lines as
   * a replay the client holds unsaved: past the memory cap they go to the file. The reply's
   * `ackedThrough` is how far the daemon released, which passes `keepFrom` after a file-cap release.
   * `truncatedThrough` is how far the spool let kept lines go on its own (at its memory or file cap,
   * on an ack or an append), so the client records each such release as a cut. Older daemons omit it.
   * `cutKeys` (opaque to the daemon) name the items the cut split, or, without `cut`, the items a
   * replay from `keepFrom` would show without their start; each ack carrying them replaces them, and
   * a later attach reports them with `savedThrough`, the furthest line the client said its journal
   * holds (an ack's `seq` may pass unsaved text a kept span replays). Older daemons keep them only
   * with `cut`.
   */
  | { id: string; type: 'relayAck'; payload: ProviderRelayAckPayload }
  /** Several relays' acks in one request; `results` answers each in order, `{ error }` for a refused one. */
  | { id: string; type: 'relayAcks'; payload: { acks: ProviderRelayAckPayload[] } }
  | { id: string; type: 'relayClose'; payload: { relayId: string; grace?: 'brief' } }
  | { id: string; type: 'relayList' }
  | {
      id: string
      type: 'relayDetach'
      payload: { relayId: string; policy?: ProviderRelayDetachPolicy }
    }

export const PROVIDER_RELAY_REQUEST_TYPES: ReadonlySet<string> = new Set<
  ProviderRelayRequest['type']
>([
  'relaySpawn',
  'relayAttach',
  'relayWrite',
  'relayAck',
  'relayAcks',
  'relayClose',
  'relayList',
  'relayDetach'
])

export type ProviderRelayAckPayload = {
  relayId: string
  seq: number
  keepFrom?: number
  cut?: true
  held?: true
  cutKeys?: string[]
  /** Every line through here is in the client's journal. */
  savedThrough?: number
}

/** More acks than this in one `relayAcks` is refused whole. */
export const RELAY_ACKS_MAX = 1024

/**
 * `daemonInstance` is this daemon start's hello `launchNonce`, so a client records which instance
 * holds the agent without racing a reconnect's new hello. Older daemons omit it.
 */
export type ProviderRelaySpawnResult =
  | { relayId: string; pid: number; daemonInstance?: string }
  | { spawnError: { code: string; message: string } }
  | { refused: 'stale-bundle' | 'unavailable' }

/**
 * How the daemon may end a detached agent nobody is using: the app's own native-chat idle stop,
 * applied only while no app is attached. Daemons before it ignore the field and keep the agent.
 */
export type ProviderRelayDetachPolicy = {
  /** Quiet time before the agent is stopped; null never stops it. */
  idleStopMs: number | null
  /** Agent lines that open, close or restate the work the open app's idle stop counts. */
  markers: ProviderRelayWorkMarker[]
  /** Client request methods that are work until the agent answers them (an ACP `session/prompt`). */
  workRequests?: string[]
  /**
   * Transport-only agent lines (a keep-alive), by top-level `method` (else `type`): the daemon
   * neither forwards nor spools them. Only a short line is checked.
   */
  quiet?: string[]
  /**
   * Agent request methods that ask to start an item: until such a request (naming `params.itemId`,
   * with no `approvalId`) is answered, that item hasn't started, so it isn't running work.
   */
  startApprovals?: string[]
  /**
   * Work open when a detach was sent, as task keys per marker group. Only a detach carries it, and
   * only a detach that carries it can idle-stop: a stream that just dropped keeps the agent running.
   */
  open?: Record<string, string[][]>
}

/**
 * One kind of agent line. It applies when its `name` is the line's top-level `method` (else `type`)
 * and every `when` holds. `start` and `end` key one task by the values at `key` (each part takes the
 * first of its paths that holds a string); an `end` with fewer parts ends every task under it. A
 * `roster` replaces its group with the tasks in the array at `list`, each keyed by `key` inside it.
 */
export type ProviderRelayWorkMarker = {
  group: string
  name: string
  effect: 'start' | 'end' | 'roster'
  when?: { path: string[]; is: string; not?: true }[]
  key: string[][][]
  list?: string[]
}

/**
 * Agent lines kept on the relay record for the next attach, one per name, so session state the
 * spool has long since acked (a session's start answer, its latest config update) is not lost.
 */
export type ProviderRelayKeepSpec = {
  /** Client request `method`s whose latest answer is kept. */
  answers: string[]
  /** Substrings; the latest agent line containing each is kept. */
  lines: string[]
  /** Client request `method`s still awaiting an answer are listed on attach, and count as work. */
  outstanding: string[]
  /** Client request `method`s whose latest accepted request is kept (its answer says nothing). */
  requests?: string[]
  /** Agent request `method`s the daemon answers itself, with this result, while no app is attached:
   *  housekeeping whose answer never depends on the app (an attached app answers as usual). */
  replies?: Record<string, unknown>
  /** The app's own note on this launch (opaque, short), handed back on each attach. */
  note?: string
}

/** A kept line's seq and the name it was kept under (`a:<method>`, `q:<method>` or `l:<marker>`). */
export type ProviderRelayKeptLine = { seq: number; name: string }

/** A client request the agent has not answered yet, or `answered` in the replay that follows;
 *  its id is from the client that sent it. */
export type ProviderRelayOutstandingRequest = {
  id: number | string
  method: string
  answered?: true
  /** Every agent line since the request is in this attach's replay. */
  replayedWhole?: true
}

/** Why the daemon ended an agent itself; output stopped, so the chat says so instead of hanging. */
export type ProviderRelayFailure =
  | 'line-too-large'
  | 'line-unreadable'
  | 'line-undeliverable'
  | 'spool-unreadable'

/** `error` names why the daemon ended the agent itself, so the chat can say so instead of hanging. */
export type ProviderRelayExit = {
  code: number | null
  signal: string | null
  error?: ProviderRelayFailure
  /** The daemon stopped the agent by the user's idle stop: its chat ended, nothing to replay into. */
  idleStopped?: true
  /** Stopped after a day detached with output no app took (or its work unknown); its spool is kept. */
  capStopped?: true
  /** The agent's last stderr, so the chat can say why it ended (absent from older daemons). */
  stderrTail?: string
}

/** One stdout line; `pending` entries are agent requests still unanswered, kept apart from the spool. */
export type ProviderRelayRecord = { seq: number; line: string }

export type ProviderRelayAttachResult = {
  /** Spool records after `fromSeq` arrive as `relayData` events up to and including this seq. */
  replayThroughSeq: number
  /** Seqs of unanswered agent requests; their lines arrive first as `relayPending` events. */
  pending: number[]
  maxClientRequestId: number | null
  /** The agent's answer to the client's first `initialize` arrived before this reply as `relayInitialize` events (seq 0). */
  initializeResultSent: boolean
  stderrTail: string
  exit: ProviderRelayExit | null
  /**
   * Work the daemon counted open while no app was attached, per marker group. The new app's own
   * view starts empty, so it keeps these until it sees them end, and hands them back at its detach.
   */
  openWork?: Record<string, string[][]>
  /** Tasks the daemon saw end while detached, which the app may still show running: restate them. */
  endedWork?: Record<string, string[][]>
  /**
   * Set once kept lines were given up (at the spool's cap, or by a cut ack), wherever the cursor
   * is: an item split there may still be open, so its later lines arrive without their start.
   * Older clients ignore it.
   */
  truncatedThrough?: number
  /** Sent as `relayKept` events before this reply; absent from daemons without `providerRelayKeep`. */
  kept?: ProviderRelayKeptLine[]
  outstanding?: ProviderRelayOutstandingRequest[]
  /** The items the client said its last cut split, when that cut is the one `truncatedThrough` names. */
  cutKeys?: string[]
  /** With `cutKeys`: the furthest line the client's journal holds. A named item's lines through
   *  it are saved already. */
  savedThrough?: number
  /** The keep spec's `note`, from the app that spawned this agent. */
  launchNote?: string
}

export type ProviderRelayInfo = {
  relayId: string
  chatKey: string
  /** Null for a relay spawned without one (an older app). */
  agent: string | null
  pid: number | null
  spawnedAtMs: number
  attached: boolean
  exit: ProviderRelayExit | null
  nextSeq: number
  ackedSeq: number
  pendingCount: number
}

/** `daemonInstance`: as in `ProviderRelaySpawnResult`, the instance this listing speaks for. */
export type ProviderRelayListResult = { relays: ProviderRelayInfo[]; daemonInstance?: string }

/** A line longer than one frame piece arrives as consecutive pieces of one seq; `more` marks all but the last. */
export type ProviderRelayDataEvent = {
  type: 'event'
  /**
   * `relayInitialize`, `relayKept` and `relayPending` are sent on attach, in that order; `relayData`
   * is the spool, in seq order, and a kept line carries the seq it was spooled at. On a
   * binary-framed stream each piece is a DATA frame carrying the raw line bytes, and the frame
   * reader restores `payload.line`; an NDJSON stream gets the JSON event.
   */
  event: 'relayData' | 'relayPending' | 'relayInitialize' | 'relayKept'
  sessionId: string
  payload: { seq: number; line: string; more?: true }
}

/**
 * Acks may be batched (about once a second is plenty). The daemon sends this once each time unacked
 * output reaches half its memory cap (half the spool file cap while the last ack set `keepFrom`), and
 * again when an ack through `seq` still leaves it there; the client should then ack everything it has
 * received.
 */
export type ProviderRelayAckWantedEvent = {
  type: 'event'
  event: 'relayAckWanted'
  sessionId: string
  payload: { seq: number }
}

export type ProviderRelayExitEvent = {
  type: 'event'
  event: 'relayExit'
  sessionId: string
  payload: ProviderRelayExit
}

/**
 * The largest `data` one `relayWrite` should carry. Even fully `\u`-escaped it stays under the
 * control socket's 16 MiB line limit, so a large write in such chunks always arrives.
 */
export const RELAY_WRITE_CHUNK_CHARS = 2 * 1024 * 1024

/** A cut names at most this many items, each key at most this long; a larger list is refused. */
export const RELAY_CUT_KEYS_MAX = 32
export const RELAY_CUT_KEY_MAX_CHARS = 256
/** A cut key saying the cut split more items than it names: a reattach moves every item it meets. */
export const RELAY_CUT_KEYS_OVERFLOW = '*'

/** Opaque item keys a cut ack names; anything past the bounds is refused, not trimmed. */
export function readProviderRelayCutKeys(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > RELAY_CUT_KEYS_MAX ||
    !value.every((key) => typeof key === 'string' && key.length <= RELAY_CUT_KEY_MAX_CHARS)
  ) {
    throw new Error('Invalid relay cut keys')
  }
  return value
}
