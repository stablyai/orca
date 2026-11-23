// Frozen relay RPC set: newer apps must be able to drive a daemon of this version unchanged.
export const PROVIDER_RELAY_PROTOCOL_VERSION = 63

/** An agent launch the daemon owns; env is complete because the daemon's own env is not the app's. */
export type ProviderRelaySpawnSpec = {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /** The app's native provider owner; the daemon cannot resolve app resources itself. */
  ownerExecutable: string
  /** The launching app's bundle; a daemon from another bundle refuses so stale code never starts chats. */
  appVersion?: string
  entryPath?: string
}

export type ProviderRelayRequest =
  | { id: string; type: 'relaySpawn'; payload: { spec: ProviderRelaySpawnSpec; chatKey: string } }
  | { id: string; type: 'relayAttach'; payload: { relayId: string; fromSeq: number } }
  | { id: string; type: 'relayWrite'; payload: { relayId: string; data: string } }
  | { id: string; type: 'relayAck'; payload: { relayId: string; seq: number } }
  | { id: string; type: 'relayClose'; payload: { relayId: string; grace?: 'brief' } }
  | { id: string; type: 'relayList' }
  | { id: string; type: 'relayDetach'; payload: { relayId: string } }

export const PROVIDER_RELAY_REQUEST_TYPES: ReadonlySet<string> = new Set<
  ProviderRelayRequest['type']
>(['relaySpawn', 'relayAttach', 'relayWrite', 'relayAck', 'relayClose', 'relayList', 'relayDetach'])

export type ProviderRelaySpawnResult =
  | { relayId: string; pid: number }
  | { spawnError: { code: string; message: string } }
  | { refused: 'stale-bundle' | 'unavailable' }

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
}

export type ProviderRelayInfo = {
  relayId: string
  chatKey: string
  pid: number | null
  spawnedAtMs: number
  attached: boolean
  exit: ProviderRelayExit | null
  nextSeq: number
  ackedSeq: number
  pendingCount: number
}

export type ProviderRelayListResult = { relays: ProviderRelayInfo[] }

/** A line longer than one frame piece arrives as consecutive pieces of one seq; `more` marks all but the last. */
export type ProviderRelayDataEvent = {
  type: 'event'
  /** `relayInitialize` and `relayPending` are sent on attach; `relayData` is the spool, in seq order. */
  event: 'relayData' | 'relayPending' | 'relayInitialize'
  sessionId: string
  payload: { seq: number; line: string; more?: true }
}

/** A `relayWrite` was refused because the agent stopped reading; resend once output moves again. */
export type ProviderRelayInputRefusedEvent = {
  type: 'event'
  event: 'relayInputRefused'
  sessionId: string
  payload: { bytes: number }
}

export type ProviderRelayExitEvent = {
  type: 'event'
  event: 'relayExit'
  sessionId: string
  payload: ProviderRelayExit
}
