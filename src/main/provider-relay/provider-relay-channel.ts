import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type {
  ProviderRelayAckWantedEvent,
  ProviderRelayAttachResult,
  ProviderRelayDataEvent,
  ProviderRelayExit,
  ProviderRelayExitEvent,
  ProviderRelayListResult,
  ProviderRelaySpawnResult,
  ProviderRelaySpawnSpec,
  ProviderRelayDetachPolicy
} from '../daemon/protocol/daemon-provider-relay-protocol'

const RELAY_REQUEST_TIMEOUT_MS = 10_000
/** A spawn waits on the agent's launch; the daemon itself bounds it, so this only catches a hung host. */
const RELAY_SPAWN_TIMEOUT_MS = 30_000

export type ProviderRelaySink = {
  line: (event: ProviderRelayDataEvent['event'], seq: number, line: string) => void
  exit: (exit: ProviderRelayExit) => void
  /** The daemon holds a lot of unacked output: ack everything received now. */
  ackWanted: () => void
  /** The stream to the daemon dropped; the daemon detached this relay. */
  disconnected: () => void
}

type ChannelEvent = ProviderRelayDataEvent | ProviderRelayAckWantedEvent | ProviderRelayExitEvent

function isRelayEvent(raw: unknown): raw is ChannelEvent {
  if (typeof raw !== 'object' || raw === null) {
    return false
  }
  const event = raw as { type?: unknown; event?: unknown; sessionId?: unknown }
  return (
    event.type === 'event' &&
    typeof event.sessionId === 'string' &&
    (event.event === 'relayData' ||
      event.event === 'relayPending' ||
      event.event === 'relayInitialize' ||
      event.event === 'relayAckWanted' ||
      event.event === 'relayExit')
  )
}

/** One daemon client's relays: RPCs, and its event stream routed to the relay each event names. */
export class ProviderRelayChannel {
  private readonly sinks = new Map<string, ProviderRelaySink>()
  /** Pieces of one long line, joined until the piece without `more`. */
  private readonly partial = new Map<string, { seq: number; pieces: string[] }>()
  private stopEvents: (() => void) | null = null
  private stopDisconnects: (() => void) | null = null

  constructor(readonly client: DaemonClient) {}

  get daemonPid(): number | null {
    return this.client.getDaemonIdentity()?.pid ?? null
  }

  bind(relayId: string, sink: ProviderRelaySink): () => void {
    this.listen()
    this.sinks.set(relayId, sink)
    return () => {
      if (this.sinks.get(relayId) === sink) {
        this.sinks.delete(relayId)
        this.partial.delete(relayId)
      }
      if (this.sinks.size === 0) {
        this.stopListening()
      }
    }
  }

  spawn(
    spec: ProviderRelaySpawnSpec,
    chatKey: string,
    policy: ProviderRelayDetachPolicy
  ): Promise<ProviderRelaySpawnResult> {
    return this.client.request('relaySpawn', { spec, chatKey, policy }, RELAY_SPAWN_TIMEOUT_MS)
  }

  attach(
    relayId: string,
    fromSeq: number,
    policy: ProviderRelayDetachPolicy
  ): Promise<ProviderRelayAttachResult> {
    this.partial.delete(relayId)
    return this.client.request(
      'relayAttach',
      { relayId, fromSeq, policy },
      RELAY_REQUEST_TIMEOUT_MS
    )
  }

  write(relayId: string, data: string): Promise<unknown> {
    return this.client.request('relayWrite', { relayId, data }, RELAY_REQUEST_TIMEOUT_MS)
  }

  ack(relayId: string, seq: number): Promise<unknown> {
    return this.client.request('relayAck', { relayId, seq }, RELAY_REQUEST_TIMEOUT_MS)
  }

  close(relayId: string, grace?: 'brief'): Promise<unknown> {
    return this.client.request(
      'relayClose',
      grace ? { relayId, grace } : { relayId },
      RELAY_SPAWN_TIMEOUT_MS
    )
  }

  /** Older relay daemons ignore `policy`; the agent then simply keeps running until it ends. */
  detach(relayId: string, policy?: ProviderRelayDetachPolicy): Promise<unknown> {
    return this.client.request(
      'relayDetach',
      policy ? { relayId, policy } : { relayId },
      RELAY_REQUEST_TIMEOUT_MS
    )
  }

  list(timeoutMs = RELAY_REQUEST_TIMEOUT_MS): Promise<ProviderRelayListResult> {
    return this.client.request('relayList', undefined, timeoutMs)
  }

  private listen(): void {
    if (this.stopEvents) {
      return
    }
    this.stopEvents = this.client.onEvent((raw) => {
      if (isRelayEvent(raw)) {
        this.route(raw)
      }
    })
    this.stopDisconnects = this.client.onDisconnected(() => {
      this.partial.clear()
      for (const sink of this.sinks.values()) {
        sink.disconnected()
      }
    })
  }

  private stopListening(): void {
    this.stopEvents?.()
    this.stopDisconnects?.()
    this.stopEvents = null
    this.stopDisconnects = null
  }

  private route(event: ChannelEvent): void {
    const sink = this.sinks.get(event.sessionId)
    if (!sink) {
      return
    }
    if (event.event === 'relayExit') {
      sink.exit(event.payload)
      return
    }
    if (event.event === 'relayAckWanted') {
      sink.ackWanted()
      return
    }
    const { seq, line, more } = event.payload
    const held = this.partial.get(event.sessionId)
    if (more) {
      if (held && held.seq === seq) {
        held.pieces.push(line)
      } else {
        this.partial.set(event.sessionId, { seq, pieces: [line] })
      }
      return
    }
    if (held) {
      this.partial.delete(event.sessionId)
      if (held.seq === seq) {
        sink.line(event.event, seq, held.pieces.join('') + line)
        return
      }
    }
    sink.line(event.event, seq, line)
  }
}

const channels = new WeakMap<DaemonClient, ProviderRelayChannel>()

export function providerRelayChannel(client: DaemonClient): ProviderRelayChannel {
  let channel = channels.get(client)
  if (!channel) {
    channel = new ProviderRelayChannel(client)
    channels.set(client, channel)
  }
  return channel
}
