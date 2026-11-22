import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, unlink } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { spawnManagedProviderProcess } from '../../provider-process/managed-provider-process'
import { installProviderOwnershipDirectory } from '../../provider-process/provider-ownership-journal'
import type {
  ProviderRelayAttachResult,
  ProviderRelayListResult,
  ProviderRelaySpawnResult,
  ProviderRelaySpawnSpec
} from '../protocol/daemon-provider-relay-protocol'
import { ProviderRelay, type ProviderRelayStream } from './provider-relay'

const PROVIDER_OWNER_EXECUTABLE = 'orca-provider-exec'
const MAX_CHAT_KEY_CHARS = 1024
const RELAY_SPOOL_NAME = /^r-(\d+)-[0-9a-f-]{36}\.ndjson$/

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

const launchString = (value: unknown): value is string =>
  typeof value === 'string' && !value.includes('\0')

function validSpec(spec: ProviderRelaySpawnSpec | undefined): spec is ProviderRelaySpawnSpec {
  return (
    !!spec &&
    launchString(spec.command) &&
    spec.command.length > 0 &&
    Array.isArray(spec.args) &&
    spec.args.every(launchString) &&
    launchString(spec.cwd) &&
    isAbsolute(spec.cwd) &&
    launchString(spec.ownerExecutable) &&
    isAbsolute(spec.ownerExecutable) &&
    basename(spec.ownerExecutable) === PROVIDER_OWNER_EXECUTABLE &&
    !!spec.env &&
    typeof spec.env === 'object' &&
    Object.entries(spec.env).every(([key, value]) => launchString(key) && launchString(value)) &&
    (spec.appVersion === undefined || typeof spec.appVersion === 'string') &&
    (spec.entryPath === undefined || typeof spec.entryPath === 'string')
  )
}

/** Only a proven-absent pid (ESRCH) frees a spool; "can't tell" keeps it. */
function ownerProvenGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** Agents this daemon owns for chats; nothing here runs until a client's first `relaySpawn`. */
export class ProviderRelayHost {
  private readonly relays = new Map<string, ProviderRelay>()
  private readonly platform: NodeJS.Platform
  private ready: Promise<string> | null = null
  private disposed = false

  constructor(private readonly options: RelayHostOptions) {
    this.platform = options.platform ?? process.platform
  }

  /** Windows keeps today's launch until a Job Object ties agents to this daemon's life. */
  get supported(): boolean {
    return this.platform !== 'win32'
  }

  get liveCount(): number {
    let live = 0
    for (const relay of this.relays.values()) {
      if (relay.live) {
        live++
      }
    }
    return live
  }

  get recordCount(): number {
    return this.relays.size
  }

  async spawn(
    spec: ProviderRelaySpawnSpec | undefined,
    chatKey: unknown
  ): Promise<ProviderRelaySpawnResult> {
    if (!this.supported || this.disposed || !this.options.acceptsWork()) {
      return { refused: 'unavailable' }
    }
    if (!validSpec(spec) || typeof chatKey !== 'string' || chatKey.length > MAX_CHAT_KEY_CHARS) {
      throw new Error('Invalid relay launch')
    }
    if (this.staleFor(spec)) {
      return { refused: 'stale-bundle' }
    }
    const directory = await this.prepare()
    if (this.disposed || !this.options.acceptsWork()) {
      return { refused: 'unavailable' }
    }
    const relayId = `r-${process.pid}-${randomUUID()}`
    const managed = spawnManagedProviderProcess(
      { command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env },
      {
        site: 'daemon-provider-relay',
        allowHost: false,
        platform: this.platform,
        inheritedEnv: {},
        ownerExecutable: spec.ownerExecutable
      }
    )
    let spawnError: Error | null = null
    managed.child.on('error', (error: Error) => {
      spawnError ??= error
    })
    const relay = new ProviderRelay({
      relayId,
      chatKey,
      managed,
      spoolPath: join(directory, `${relayId}.ndjson`),
      onExit: () => {
        this.removeIfFinished(relay)
        this.options.onLiveCountChanged()
      }
    })
    this.relays.set(relayId, relay)
    await managed.child.ready?.catch(() => {})
    const pid = managed.child.pid
    if (pid === undefined) {
      this.relays.delete(relayId)
      await relay.dispose()
      const error = spawnError as (Error & { code?: unknown }) | null
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
  attach(
    clientId: string,
    stream: ProviderRelayStream,
    relayId: string,
    fromSeq: unknown
  ): Promise<ProviderRelayAttachResult> {
    return this.require(relayId).attach(clientId, stream, typeof fromSeq === 'number' ? fromSeq : 0)
  }

  write(clientId: string, relayId: string, data: unknown): void {
    if (typeof data !== 'string') {
      throw new Error('Invalid relay write')
    }
    this.requireAttached(clientId, relayId).write(data)
  }

  ack(clientId: string, relayId: string, seq: unknown): void {
    const relay = this.requireAttached(clientId, relayId)
    relay.ack(typeof seq === 'number' ? seq : 0)
    this.removeIfFinished(relay)
  }

  async close(relayId: string, grace: unknown): Promise<void> {
    await this.require(relayId).close(grace === 'brief' ? 'brief' : undefined)
  }

  async detach(clientId: string, relayId: string): Promise<void> {
    await this.require(relayId).detach(clientId)
  }

  list(): ProviderRelayListResult {
    return { relays: [...this.relays.values()].map((relay) => relay.info()) }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const relays = [...this.relays.values()]
    this.relays.clear()
    await Promise.all(relays.map((relay) => relay.dispose()))
  }

  private staleFor(spec: ProviderRelaySpawnSpec): boolean {
    const { appVersion, entryPath } = this.options
    return (
      (appVersion ?? undefined) !== spec.appVersion ||
      (entryPath !== null && spec.entryPath !== undefined && entryPath !== spec.entryPath)
    )
  }

  private require(relayId: unknown): ProviderRelay {
    const relay = typeof relayId === 'string' ? this.relays.get(relayId) : undefined
    if (!relay) {
      throw new Error('Relay not found')
    }
    return relay
  }

  private requireAttached(clientId: string, relayId: unknown): ProviderRelay {
    const relay = this.require(relayId)
    if (relay.attachedClientId !== clientId) {
      throw new Error('Relay not attached to this client')
    }
    return relay
  }

  private removeIfFinished(relay: ProviderRelay): void {
    if (relay.finished && this.relays.get(relay.relayId) === relay) {
      this.relays.delete(relay.relayId)
      void relay.dispose()
    }
  }

  private prepare(): Promise<string> {
    this.ready ??= this.prepareOnce().catch((error: unknown) => {
      this.ready = null
      throw error
    })
    return this.ready
  }

  private async prepareOnce(): Promise<string> {
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
    installProviderOwnershipDirectory(journal)
    await this.removeDeadOwnersSpools(directory)
    return directory
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
