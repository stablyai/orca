import type {
  IPtyProvider,
  PtyProcessInfo,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/pty-provider-contract'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

export class DegradedDaemonOwnerRecovery {
  private readonly attachResolver: DaemonSessionOwnerResolver<IPtyProvider>
  private readonly livenessResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>

  constructor(
    providers: readonly IPtyProvider[],
    private readonly daemonAdapters: readonly DaemonPtyAdapter[],
    private readonly routes: Map<string, IPtyProvider>,
    private readonly spawnFresh: (opts: PtySpawnOptions) => Promise<PtySpawnResult>
  ) {
    this.attachResolver = new DaemonSessionOwnerResolver(providers, routes)
    this.livenessResolver = new DaemonSessionOwnerResolver(daemonAdapters, routes)
  }

  resolveFencedOwner = (id: string, incarnationId: string) =>
    this.attachResolver.resolveTermination(id, incarnationId)

  spawn = async (opts: PtySpawnOptions): Promise<PtySpawnResult> => {
    if (opts.attachOnly && opts.sessionId) {
      return await this.attachResolver.spawnAttachOnly({ ...opts, sessionId: opts.sessionId })
    }
    const result = await this.spawnFresh(opts)
    const provider = this.routes.get(result.id)
    if (provider && !result.exitedBeforeSpawnReply) {
      this.recordRoute(result.id, provider, result.incarnationId)
    }
    return result
  }

  getVerifiedRoute = (id: string): IPtyProvider | undefined =>
    this.attachResolver.getVerifiedRoute(id)

  probe = async (sessionId: string): Promise<boolean | null> =>
    await this.livenessResolver.probe(sessionId)

  discoverRoutes = async (): Promise<void> => await this.attachResolver.discoverRoutes()

  async listProcesses(
    opts?: Parameters<IPtyProvider['listProcesses']>[0]
  ): Promise<PtyProcessInfo[]> {
    return this.attachResolver.listProcesses(opts)
  }

  async reconcileOnStartup(validWorktreeIds: Set<string>): Promise<{
    alive: string[]
    killed: string[]
  }> {
    const alive: string[] = []
    const killed: string[] = []
    const aliveProviders = new Map<string, Set<DaemonPtyAdapter>>()
    for (const adapter of this.daemonAdapters) {
      const result = await adapter.reconcileOnStartup(validWorktreeIds)
      for (const id of result.alive) {
        alive.push(id)
        const providers = aliveProviders.get(id) ?? new Set<DaemonPtyAdapter>()
        providers.add(adapter)
        aliveProviders.set(id, providers)
      }
      killed.push(...result.killed)
    }
    for (const id of new Set([...alive, ...killed])) {
      const providers = aliveProviders.get(id)
      if (providers?.size === 1) {
        this.recordRoute(id, providers.values().next().value!)
      } else {
        this.forgetRoute(id)
      }
    }
    return { alive, killed }
  }

  recordRoute(sessionId: string, provider: IPtyProvider, incarnationId?: string): void {
    this.attachResolver.recordRoute(sessionId, provider, incarnationId)
    const adapter = this.daemonAdapters.find((candidate) => candidate === provider)
    if (adapter) {
      this.livenessResolver.recordRoute(sessionId, adapter, incarnationId)
    }
  }

  forgetRoute(sessionId: string): void {
    this.attachResolver.forgetRoute(sessionId)
    this.livenessResolver.forgetRoute(sessionId)
  }

  subscribeIdentityChanges(): (() => void)[] {
    return this.daemonAdapters.flatMap((adapter) =>
      typeof adapter.onDaemonIdentityChanged === 'function'
        ? [
            adapter.onDaemonIdentityChanged(() => {
              this.attachResolver.invalidateProvider(adapter)
              this.livenessResolver.invalidateProvider(adapter)
            })
          ]
        : []
    )
  }
}
