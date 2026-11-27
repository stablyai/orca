import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  RELAY_CUT_KEY_MAX_CHARS,
  RELAY_CUT_KEYS_MAX,
  type ProviderRelayAttachResult,
  type ProviderRelayListResult,
  type ProviderRelaySpawnResult,
  type ProviderRelaySpawnSpec
} from '../protocol/daemon-provider-relay-protocol'
import { ProviderRelay } from './provider-relay'
import { ProviderRelayDetachedCap } from './provider-relay-detached-cap'
import { ProviderRelayEndedRetention } from './provider-relay-ended-retention'
import type { ProviderRelayStream } from './provider-relay-attachment'
import { waitAtMost } from './provider-relay-bounded-wait'
import { readProviderRelayDetachPolicy } from './provider-relay-idle-stop'
import { validProviderRelaySpawnSpec } from './provider-relay-spawn-spec'
import {
  prepareProviderRelayDirectory,
  type ProviderRelayDirectory as Prepared
} from './provider-relay-directory'

const MAX_CHAT_KEY_CHARS = 1024
/** Relay cleanup is disk work; shutdown waits for it only this long. */
const DISPOSE_WAIT_MS = 3000

type RelayHostOptions = {
  /** `<daemon runtime dir>`; spools and the ownership journal live under its `chat-relay/`. */
  runtimeDir: string
  appVersion: string | null
  entryPath: string | null
  /** Echoed in spawn and list replies so a client knows which daemon start holds an agent. */
  daemonInstance?: string | null
  platform?: NodeJS.Platform
  acceptsWork: () => boolean
  onLiveCountChanged: () => void
  log: (event: string, details?: Record<string, unknown>) => void
}

/** Agents this daemon owns for chats; nothing here runs until a client's first `relaySpawn`. */
export class ProviderRelayHost {
  private readonly relays = new Map<string, ProviderRelay>()
  private readonly retention = new ProviderRelayEndedRetention<ProviderRelay>((relay) => {
    if (!relay.live) {
      this.remove(relay)
    }
  })
  private readonly cap = new ProviderRelayDetachedCap((event, details) =>
    this.options.log(event, details)
  )
  private readonly platform: NodeJS.Platform
  private ready: Promise<Prepared> | null = null
  private disposed = false
  private disposing: Promise<void> | null = null

  constructor(private readonly options: RelayHostOptions) {
    this.platform = options.platform ?? process.platform
  }

  get daemonInstance(): string | null {
    return this.options.daemonInstance ?? null
  }

  /** Windows keeps today's launch until a Job Object ties agents to this daemon's life. */
  get supported(): boolean {
    return this.platform !== 'win32'
  }

  /** Running agents plus ended ones whose output no client has acked yet (bounded by expiry). */
  get liveCount(): number {
    return this.relays.size
  }

  get runningCount(): number {
    let running = 0
    for (const relay of this.relays.values()) {
      running += relay.live ? 1 : 0
    }
    return running
  }

  async spawn(
    spec: ProviderRelaySpawnSpec | undefined,
    chatKey: unknown,
    policy?: unknown,
    agent?: unknown
  ): Promise<ProviderRelaySpawnResult> {
    if (!this.supported || this.disposed || !this.options.acceptsWork()) {
      return { refused: 'unavailable' }
    }
    if (
      !validProviderRelaySpawnSpec(spec) ||
      typeof chatKey !== 'string' ||
      chatKey.length > MAX_CHAT_KEY_CHARS
    ) {
      throw new Error('Invalid relay launch')
    }
    const { directory, spawn, reaper } = await this.prepare()
    if (this.disposed || !this.options.acceptsWork()) {
      return { refused: 'unavailable' }
    }
    const relayId = `r-${process.pid}-${randomUUID()}`
    const managed = spawn(
      { command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env },
      {
        site: 'daemon-provider-relay',
        allowHost: false,
        platform: this.platform,
        inheritedEnv: {},
        ownerExecutable: spec.ownerExecutable
      }
    )
    const failure: { error: (Error & { code?: unknown }) | null } = { error: null }
    managed.child.on('error', (error: Error & { code?: unknown }) => {
      failure.error ??= error
    })
    const relay = new ProviderRelay({
      relayId,
      chatKey,
      agent: typeof agent === 'string' && agent.length <= MAX_CHAT_KEY_CHARS ? agent : null,
      managed,
      // A command the agent moved to its own process group must not outlive a close.
      tree: reaper(managed.child, {
        site: 'daemon-provider-relay-close',
        exited: () => managed.rootVerdict === 'exited',
        supervised: managed.supervised
      }),
      spoolPath: join(directory, `${relayId}.ndjson`),
      log: this.options.log,
      onSettled: () => {
        this.removeIfFinished(relay)
        this.expireWhenAbandoned(relay)
        this.cap.forget(relay)
        this.options.onLiveCountChanged()
      },
      onDetached: () => {
        this.expireWhenAbandoned(relay)
        this.cap.detached(relay)
      },
      onIdleUnread: () => this.cap.idleUnread(relay)
    })
    relay.idleStopPolicy.configure(readProviderRelayDetachPolicy(policy))
    this.relays.set(relayId, relay)
    await managed.child.ready?.catch(() => {})
    // Shutdown during the launch closes this agent; the caller must not be told it runs.
    if (this.disposed || !this.options.acceptsWork()) {
      this.remove(relay)
      return { refused: 'unavailable' }
    }
    const pid = managed.child.pid
    if (pid === undefined) {
      this.remove(relay)
      const { error } = failure
      return {
        spawnError: {
          code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
          message: error?.message ?? 'Provider launch failed'
        }
      }
    }
    this.options.log('relay-spawned', { relayId, pid })
    this.cap.spawned(relay)
    return { relayId, pid }
  }

  /** A second attach takes the relay over; the earlier stream simply stops receiving it. */
  async attach(
    clientId: string,
    stream: ProviderRelayStream,
    relayId: unknown,
    fromSeq: unknown,
    policy?: unknown
  ): Promise<ProviderRelayAttachResult> {
    // An ended relay's expiry keeps running through attaches: it lives at most a day after it ends.
    const relay = this.requireRelay(relayId)
    relay.idleStopPolicy.configure(readProviderRelayDetachPolicy(policy))
    try {
      const attached = await relay.attach(
        clientId,
        stream,
        typeof fromSeq === 'number' ? fromSeq : 0
      )
      // Only an attach that held counts: a failed one leaves the detach's deadline in place.
      if (relay.attachedClientId !== null) {
        this.cap.forget(relay)
      }
      return attached
    } finally {
      // An ended relay with nothing left to ack is done once a client has seen its outcome.
      this.removeIfFinished(relay)
    }
  }

  write(clientId: string, relayId: unknown, data: unknown): void {
    if (typeof data !== 'string') {
      throw new Error('Invalid relay write')
    }
    this.requireAttached(clientId, relayId).write(data)
  }

  ack(
    clientId: string,
    relayId: unknown,
    seq: unknown,
    keepFrom?: unknown,
    flags?: { cut?: unknown; held?: unknown; cutKeys?: unknown }
  ): { ackedThrough: number; truncatedThrough: number } {
    const relay = this.requireAttached(clientId, relayId)
    const acked = relay.ack(
      typeof seq === 'number' ? seq : 0,
      typeof keepFrom === 'number' ? keepFrom : undefined,
      {
        cut: flags?.cut === true,
        held: flags?.held === true,
        cutKeys: flags?.cutKeys === undefined ? undefined : relayCutKeys(flags.cutKeys)
      }
    )
    this.removeIfFinished(relay)
    return acked
  }

  /** A closed chat wants nothing more from its agent, so the ended relay goes with its spool. */
  async close(relayId: unknown, grace: unknown): Promise<void> {
    const relay = this.requireRelay(relayId)
    await relay.close(grace === 'brief' ? 'brief' : undefined)
    if (!relay.live) {
      this.remove(relay)
    }
  }

  async detach(clientId: string, relayId: unknown, policy?: unknown): Promise<void> {
    await this.requireRelay(relayId).detach(clientId, readProviderRelayDetachPolicy(policy))
  }

  list(): ProviderRelayListResult {
    return { relays: [...this.relays.values()].map((relay) => relay.info()) }
  }

  /** Every caller waits for the same cleanup, so a second shutdown path can't overtake the first. */
  dispose(): Promise<void> {
    this.disposing ??= this.disposeOnce()
    return this.disposing
  }

  private async disposeOnce(): Promise<void> {
    this.disposed = true
    this.cap.stop()
    this.retention.dispose()
    const relays = [...this.relays.values()]
    this.relays.clear()
    await waitAtMost(Promise.all(relays.map((relay) => relay.dispose())), DISPOSE_WAIT_MS)
  }

  private requireRelay(relayId: unknown): ProviderRelay {
    const relay = typeof relayId === 'string' ? this.relays.get(relayId) : undefined
    if (!relay) {
      throw new Error('Relay not found')
    }
    return relay
  }

  private requireAttached(clientId: string, relayId: unknown): ProviderRelay {
    const relay = this.requireRelay(relayId)
    if (relay.attachedClientId !== clientId) {
      throw new Error('Relay not attached to this client')
    }
    return relay
  }

  private registered(relay: ProviderRelay): boolean {
    return this.relays.get(relay.relayId) === relay
  }

  private removeIfFinished(relay: ProviderRelay): void {
    if (relay.finished) {
      this.remove(relay)
    }
  }

  private remove(relay: ProviderRelay): void {
    this.retention.clear(relay)
    if (this.registered(relay)) {
      this.relays.delete(relay.relayId)
      void relay.dispose()
      this.options.onLiveCountChanged()
    }
  }

  private expireWhenAbandoned(relay: ProviderRelay): void {
    // A late stdout end on an already removed relay must not pin it with a timer.
    // Attached or not: a client that stops acking can't keep an ended agent's output forever.
    if (this.registered(relay)) {
      this.retention.schedule(relay)
    }
  }

  private prepare(): Promise<Prepared> {
    this.ready ??= prepareProviderRelayDirectory(this.options.runtimeDir).catch(
      (error: unknown) => {
        this.ready = null
        throw error
      }
    )
    return this.ready
  }
}

/** Opaque item keys a cut ack names; anything past the bounds is refused, not trimmed. */
function relayCutKeys(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > RELAY_CUT_KEYS_MAX ||
    !value.every((key) => typeof key === 'string' && key.length <= RELAY_CUT_KEY_MAX_CHARS)
  ) {
    throw new Error('Invalid relay cut keys')
  }
  return value
}
