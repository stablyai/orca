import type {
  CodexAppServerLaunch,
  spawnCodexAppServerConnection
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

/** A server with no chats waits this long for the next one before it stops. */
const IDLE_SERVER_STOP_MS = 60_000

export type CodexSharedServerOpenOptions = {
  sessionId: string
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
  private readonly ceiling = new CodexSharedServerMemoryCeiling(
    () => this.allServers(),
    (server) => this.onServerFreed(server)
  )

  constructor(
    private readonly connect?: typeof spawnCodexAppServerConnection,
    private readonly sweep?: CodexSharedServerProcessSweep
  ) {}

  async open(
    launch: CodexAppServerLaunch,
    handlers: CodexAppServerConnectionHandlers,
    options: CodexSharedServerOpenOptions
  ): Promise<CodexAppServerConnection> {
    const spec = await codexSharedServerSpec(
      launch,
      options.skillRoots,
      options.codexVersion ?? null
    )
    this.ceiling.sampleIfStale()
    for (const stale of this.unproven) {
      this.stop(stale)
    }
    const server = this.liveServer(spec.key) ?? this.startServer(spec)
    this.cancelIdleStop(server)
    // Reserved before the server is ready, so concurrent opens join the same server.
    const lease = new CodexSharedServerLease(server, handlers, options.sessionId, spec.chatEnv)
    server.leases.add(lease)
    try {
      await server.ready
      if (server.closed) {
        throw new Error('codex shared app-server exited before the chat joined it')
      }
      await lease.announce()
      // The server can exit while onSpawned runs; that ends the reserved lease.
      if (lease.closed) {
        throw new Error('codex shared app-server exited before the chat joined it')
      }
    } catch (error) {
      await server.release(lease).catch(() => {})
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
    const server = new CodexSharedServer(
      spec,
      (ended) => this.onServerFreed(ended),
      this.connect,
      this.sweep
    )
    server.ready.catch(() => this.remove(server))
    const group = this.servers.get(spec.key) ?? []
    group.push(server)
    this.servers.set(spec.key, group)
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
    if (server.leases.size > 0) {
      return
    }
    if (server.draining) {
      this.stop(server)
      return
    }
    if (!this.idleTimers.has(server)) {
      const timer = setTimeout(() => {
        this.idleTimers.delete(server)
        if (server.leases.size === 0) {
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
