import {
  spawnCodexAppServerConnection,
  type CodexAppServerLaunch
} from '../codex-app-server-connection'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from '../codex-app-server-connection-types'
import { codexSharedServerSpec } from './codex-shared-server-key'
import { CodexSharedServerLease } from './codex-shared-server-lease'
import { CodexSharedServer } from './codex-shared-server'
import type { CodexSharedServerProcessSweep } from './codex-shared-server-chat-workload'
import { CodexSharedServerMemoryCeiling } from './codex-shared-server-memory-ceiling'
import {
  CodexSharedServerUncontainedError,
  CodexSharedServerWindowsJob
} from './codex-shared-server-windows-job'
import {
  onProviderRelayQuit,
  providerRelayQuitting,
  providerRelayRouteInstalled
} from '../../../provider-relay/app-provider-relays'
import {
  forgetListedProviderRelayChat,
  noteProviderRelayReattachedFromLastRun
} from '../../../provider-relay/provider-relay-launch-inventory'
import { codexSharedRelayChatKey, onCodexSharedRelayChats } from './codex-shared-server-relay'
import { codexPooledRunOf, codexRecordPooledRun } from './codex-shared-server-kept-runs'
import { CodexKeptServers } from './codex-shared-server-kept-servers'

/** A server with no chats waits this long for the next one before it stops. */
const IDLE_SERVER_STOP_MS = 60_000

export type CodexSharedServerOpenOptions = {
  sessionId: string
  /** Its run may outlive this app; false for a chat whose tools end with it (a bot's). */
  keepable?: boolean
  /** skills/extraRoots/set replaces the whole process's list, so the roots are part of the key. */
  skillRoots: readonly string[]
  /** What the launch's `codex --version` reported; part of the drain generation. */
  codexVersion?: string | null
}

/** One server per launch key serves every chat on it; a new one starts only once it drains. */
export class CodexSharedServerPool {
  private readonly servers = new Map<string, CodexSharedServer[]>()
  private readonly idleTimers = new Map<CodexSharedServer, ReturnType<typeof setTimeout>>()
  /** Out of selection, kept until their exit is proven so none is orphaned. */
  private readonly stopping = new Set<CodexSharedServer>()
  /** Stops that couldn't prove an exit, retried when the next chat opens. */
  private readonly unproven = new Set<CodexSharedServer>()
  /** Windows: settles once the server's tree is proven held in its job, after it is ready. */
  private readonly contained = new WeakMap<CodexSharedServer, Promise<void>>()
  private readonly ceiling = new CodexSharedServerMemoryCeiling(
    () => this.allServers(),
    (server) => this.onServerFreed(server)
  )
  /** Relayed servers by relay, and the kept ones a chat's run is on. */
  readonly kept = new CodexKeptServers({
    track: (server) => this.track(server),
    freed: (server) => this.onServerFreed(server),
    sweep: () => this.sweep
  })

  constructor(
    private readonly connect?: typeof spawnCodexAppServerConnection,
    private readonly sweep?: CodexSharedServerProcessSweep,
    /** Windows: each server's job; null when one can't be made. Undefined elsewhere. */
    private readonly createWindowsJob: () => CodexSharedServerWindowsJob | null | undefined = () =>
      process.platform === 'win32' ? CodexSharedServerWindowsJob.create() : undefined
  ) {
    onProviderRelayQuit(() => {
      for (const server of this.allServers()) {
        server.keep.settleQuit()
      }
    })
  }

  /** The daemon runs servers where it can (never on Windows, nor for an injected test spawn). */
  private get relaying(): boolean {
    return !this.connect && process.platform !== 'win32' && providerRelayRouteInstalled()
  }

  async open(
    launch: CodexAppServerLaunch,
    handlers: CodexAppServerConnectionHandlers,
    options: CodexSharedServerOpenOptions
  ): Promise<CodexAppServerConnection> {
    const keepable = options.keepable !== false
    const launchSpec = await codexSharedServerSpec(launch, options.skillRoots, options.codexVersion)
    // A chat whose run ends with this app (a bot's) never shares a server that outlives it.
    const spec =
      keepable || !this.relaying ? launchSpec : { ...launchSpec, key: `${launchSpec.key}:app` }
    this.ceiling.sampleIfStale()
    for (const stale of this.unproven) {
      this.stop(stale)
    }
    const run = this.relaying && keepable ? codexPooledRunOf(options.sessionId) : null
    const kept = run ? await this.kept.serverFor(options.sessionId, run, spec) : null
    const server = kept?.server ?? this.liveServer(spec.key) ?? this.startServer(spec)
    this.cancelIdleStop(server)
    if (kept) {
      // Its own commands keep their tag, and its threads come back with what they held.
      forgetListedProviderRelayChat(options.sessionId)
      noteProviderRelayReattachedFromLastRun(options.sessionId)
    }
    // Reserved before the server is ready, so concurrent opens join the same server.
    const lease = new CodexSharedServerLease(
      server,
      handlers,
      options.sessionId,
      spec.chatEnv,
      kept ? { workload: kept.chat.workload, chat: kept.chat } : null,
      keepable
    )
    server.leases.add(lease)
    try {
      await (this.contained.get(server) ?? server.ready)
      if (server.closed) {
        throw new Error('codex shared app-server exited before the chat joined it')
      }
      this.kept.placeRun(options.sessionId, server, lease)
      await lease.announce()
      // The server can exit while onSpawned runs; that ends the reserved lease.
      if (lease.closed) {
        throw new Error('codex shared app-server exited before the chat joined it')
      }
    } catch (error) {
      if (lease.restored) {
        // A restored chat that couldn't join leaves its run as it was, for its next open.
        lease.handBack()
      } else {
        await server.release(lease).catch(() => {})
      }
      throw error
    }
    return lease
  }

  private allServers(): CodexSharedServer[] {
    return [...[...this.servers.values()].flat(), ...this.stopping]
  }

  private liveServer(key: string): CodexSharedServer | undefined {
    return this.servers.get(key)?.find((server) => !server.draining)
  }

  private startServer(spec: CodexSharedServer['spec']): CodexSharedServer {
    const windowsJob = this.createWindowsJob()
    if (windowsJob === null) {
      throw new CodexSharedServerUncontainedError()
    }
    const connect = this.connect ?? spawnCodexAppServerConnection
    const server = new CodexSharedServer(
      spec,
      (ended) => this.onServerFreed(ended),
      windowsJob ? windowsJob.connect(connect) : connect,
      this.sweep,
      this.relaying && !windowsJob && !spec.key.endsWith(':app')
        ? { chatKey: codexSharedRelayChatKey(spec.key) }
        : undefined
    )
    this.track(server)
    if (windowsJob) {
      // A server its job can't hold couldn't end what chats leave running.
      const held = server.ready.then(() => windowsJob.requireHolds(server.pid, () => server.exited))
      held.catch(() => {
        // Its waiting chats leave silently: their open rejects and a fallback reuses their handlers.
        server.leases.clear()
        this.stop(server)
      })
      this.contained.set(server, held)
    }
    return server
  }

  private track(server: CodexSharedServer): CodexSharedServer {
    server.ready.catch(() => this.remove(server))
    const group = this.servers.get(server.spec.key) ?? []
    group.push(server)
    this.servers.set(server.spec.key, group)
    this.kept.noteAttached(server)
    return server
  }

  /** Called when a chat leaves a server or the server exits. */
  private onServerFreed(server: CodexSharedServer): void {
    if (server.exited) {
      this.remove(server)
      this.stopping.delete(server)
      this.unproven.delete(server)
      return
    }
    server.keep.settleQuit()
    if (providerRelayQuitting() || server.leases.size > 0) {
      return
    }
    if (server.draining && server.recovery.empty) {
      this.stop(server)
      return
    }
    if (!this.idleTimers.has(server)) {
      const timer = setTimeout(() => {
        this.idleTimers.delete(server)
        if (server.leases.size > 0 || providerRelayQuitting()) {
          return
        }
        // Threads held for chats not open here go back to the daemon with the server, never ended.
        if (!server.recovery.empty && server.relay) {
          this.handBack(server)
        } else {
          this.stop(server)
        }
      }, IDLE_SERVER_STOP_MS)
      timer.unref?.()
      this.idleTimers.set(server, timer)
    }
  }

  private cancelIdleStop(server: CodexSharedServer): void {
    const timer = this.idleTimers.get(server)
    if (timer) {
      clearTimeout(timer)
      this.idleTimers.delete(server)
    }
  }

  /** Its daemon idle-stops it once nothing runs; a later open of one of its chats reattaches it. */
  private handBack(server: CodexSharedServer): void {
    this.remove(server)
    void this.kept.handBack(server).then((handed) => {
      if (handed) {
        server.exitedWith(new Error('codex app-server handed back to its daemon'))
      } else if (!server.exited) {
        this.stop(server)
      }
    })
  }

  private stop(server: CodexSharedServer): void {
    this.remove(server)
    this.stopping.add(server)
    this.unproven.delete(server)
    void server.stop().then((proven) => {
      if (proven || server.exited || server.leases.size > 0) {
        this.stopping.delete(server)
        return
      }
      // No timer: its exit clears it, and the next chat to open retries the stop.
      console.warn(`[codex-shared-server] pid ${server.pid ?? '?'} has not proven its exit`)
      this.unproven.add(server)
    })
  }

  private remove(server: CodexSharedServer): void {
    this.cancelIdleStop(server)
    this.kept.forget(server)
    const group = this.servers.get(server.spec.key)
    if (!group) {
      return
    }
    const remaining = group.filter((candidate) => candidate !== server)
    if (remaining.length > 0) {
      this.servers.set(server.spec.key, remaining)
    } else {
      this.servers.delete(server.spec.key)
    }
  }
}

let pool: CodexSharedServerPool | null = null

/** Built on the first shared open, so a host that never opts in never creates it. */
export function sharedCodexServerPool(): CodexSharedServerPool {
  pool ??= new CodexSharedServerPool()
  return pool
}

onCodexSharedRelayChats({
  dropped: (chatKey, relay) => pool?.kept.dropped(chatKey, relay),
  // A deleted chat's run may be kept from an earlier run before any chat here built the pool.
  stop: async (record) =>
    codexRecordPooledRun(record) ? sharedCodexServerPool().kept.stopDeleted(record) : 'stopped'
})
