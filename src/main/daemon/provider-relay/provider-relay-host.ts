import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { spawnManagedProviderProcess } from '../../provider-process/managed-provider-process'
import type {
  ProviderRelayAttachResult,
  ProviderRelayListResult,
  ProviderRelaySpawnResult,
  ProviderRelaySpawnSpec
} from '../protocol/daemon-provider-relay-protocol'
import { ProviderRelay } from './provider-relay'
import type { ProviderRelayStream } from './provider-relay-attachment'
import { waitAtMost } from './provider-relay-bounded-wait'
import { readProviderRelayDetachPolicy } from './provider-relay-idle-stop'
import { validProviderRelaySpawnSpec } from './provider-relay-spawn-spec'

type SpawnManaged = typeof spawnManagedProviderProcess

const MAX_CHAT_KEY_CHARS = 1024
/** An ended relay nobody collects is dropped after this, so it never holds the daemon or its spool forever. */
const ENDED_RELAY_RETENTION_MS = 24 * 60 * 60 * 1000
/** Relay cleanup is disk work; shutdown waits for it only this long. */
const DISPOSE_WAIT_MS = 3000
const RELAY_SPOOL_NAME = /^r-(\d+)-[0-9a-f-]{36}\.ndjson(?:\.line|\.compact)?$/

type RelayHostOptions = {
  /** `<daemon runtime dir>`; spools and the ownership journal live under its `chat-relay/`. */
  runtimeDir: string
  appVersion: string | null
  entryPath: string | null
  platform?: NodeJS.Platform
  acceptsWork: () => boolean
  onLiveCountChanged: () => void
  log: (event: string, details?: Record<string, unknown>) => void
}

/** Only a proven-absent pid (ESRCH) frees a spool; "can't tell" keeps it. */
function ownerProvenGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}

/** Agents this daemon owns for chats; nothing here runs until a client's first `relaySpawn`. */
export class ProviderRelayHost {
  private readonly relays = new Map<string, ProviderRelay>()
  private readonly expiries = new Map<ProviderRelay, ReturnType<typeof setTimeout>>()
  private readonly platform: NodeJS.Platform
  private ready: Promise<{ directory: string; spawn: SpawnManaged }> | null = null
  private disposed = false
  private disposing: Promise<void> | null = null

  constructor(private readonly options: RelayHostOptions) {
    this.platform = options.platform ?? process.platform
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
    agent?: unknown,
    keep?: unknown
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
    const { directory, spawn } = await this.prepare()
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
    managed.child.on('error', (error: Error & { code?: unknown }) => void (failure.error ??= error))
    const relay = new ProviderRelay({
      relayId,
      chatKey,
      agent: typeof agent === 'string' && agent.length <= MAX_CHAT_KEY_CHARS ? agent : null,
      managed,
      spoolPath: join(directory, `${relayId}.ndjson`),
      log: this.options.log,
      onSettled: () => {
        this.removeIfFinished(relay)
        this.expireWhenAbandoned(relay)
        this.options.onLiveCountChanged()
      },
      onDetached: () => this.expireWhenAbandoned(relay)
    })
    relay.idleStopPolicy.configure(readProviderRelayDetachPolicy(policy))
    relay.pending.kept.configure(keep)
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
    return { relayId, pid }
  }

  /** A second attach takes the relay over; the earlier stream simply stops receiving it. */
  async attach(
    clientId: string,
    stream: ProviderRelayStream,
    relayId: unknown,
    fromSeq: unknown,
    policy?: unknown,
    kept?: unknown
  ): Promise<ProviderRelayAttachResult> {
    // An ended relay's expiry keeps running through attaches: it lives at most a day after it ends.
    const relay = this.requireRelay(relayId)
    relay.idleStopPolicy.configure(readProviderRelayDetachPolicy(policy))
    relay.pending.kept.sendOnAttach = kept === true
    try {
      return await relay.attach(clientId, stream, typeof fromSeq === 'number' ? fromSeq : 0)
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
    flags?: { cut?: unknown; held?: unknown }
  ): number {
    const relay = this.requireAttached(clientId, relayId)
    const ackedThrough = relay.ack(
      typeof seq === 'number' ? seq : 0,
      typeof keepFrom === 'number' ? keepFrom : undefined,
      { cut: flags?.cut === true, held: flags?.held === true }
    )
    this.removeIfFinished(relay)
    return ackedThrough
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
    for (const timer of this.expiries.values()) {
      clearTimeout(timer)
    }
    this.expiries.clear()
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
    this.clearExpiry(relay)
    if (this.registered(relay)) {
      this.relays.delete(relay.relayId)
      void relay.dispose()
      this.options.onLiveCountChanged()
    }
  }

  private expireWhenAbandoned(relay: ProviderRelay): void {
    // A late stdout end on an already removed relay must not pin it with a timer.
    // Attached or not: a client that stops acking can't keep an ended agent's output forever.
    if (!this.registered(relay) || relay.live || this.expiries.has(relay)) {
      return
    }
    const timer = setTimeout(() => {
      this.expiries.delete(relay)
      if (!relay.live) {
        this.remove(relay)
      }
    }, ENDED_RELAY_RETENTION_MS)
    timer.unref?.()
    this.expiries.set(relay, timer)
  }

  private clearExpiry(relay: ProviderRelay): void {
    const timer = this.expiries.get(relay)
    if (timer) {
      clearTimeout(timer)
      this.expiries.delete(relay)
    }
  }

  private prepare(): Promise<{ directory: string; spawn: SpawnManaged }> {
    this.ready ??= this.prepareOnce().catch((error: unknown) => {
      this.ready = null
      throw error
    })
    return this.ready
  }

  /** Spawn code loads on the first chat only, so a daemon that never relays starts as fast as before. */
  private async prepareOnce(): Promise<{ directory: string; spawn: SpawnManaged }> {
    const directory = join(this.options.runtimeDir, 'chat-relay')
    const journal = join(directory, 'provider-processes')
    await mkdir(journal, { recursive: true, mode: 0o700 })
    for (const path of [directory, journal]) {
      const info = await lstat(path)
      if (
        !info.isDirectory() ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      ) {
        throw new Error('Relay directory is not private')
      }
    }
    const [{ spawnManagedProviderProcess }, { installProviderOwnershipDirectory }] =
      await Promise.all([
        import('../../provider-process/managed-provider-process'),
        import('../../provider-process/provider-ownership-journal')
      ])
    installProviderOwnershipDirectory(journal)
    await this.removeDeadOwnersSpools(directory)
    return { directory, spawn: spawnManagedProviderProcess }
  }

  /** A spool only its creating daemon can read; once that daemon is proven gone, nobody can. */
  private async removeDeadOwnersSpools(directory: string): Promise<void> {
    const names = await readdir(directory).catch(() => [])
    for (const name of names) {
      const owner = RELAY_SPOOL_NAME.exec(name)?.[1]
      if (owner && Number(owner) !== process.pid && ownerProvenGone(Number(owner))) {
        await unlink(join(directory, name)).catch(() => {})
      }
    }
  }
}
