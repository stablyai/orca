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
  private readonly identityUnsubscribes: (() => void)[] = []
  private readonly identitySubscribed = new Set<DaemonPtyAdapter>()
  private identityTracking = false

  constructor(
    private readonly readProviders: () => readonly IPtyProvider[],
    private readonly readDaemonAdapters: () => readonly DaemonPtyAdapter[],
    private readonly routes: Map<string, IPtyProvider>,
    private readonly spawnFresh: (opts: PtySpawnOptions) => Promise<PtySpawnResult>
  ) {
    this.attachResolver = new DaemonSessionOwnerResolver([], routes)
    this.livenessResolver = new DaemonSessionOwnerResolver([], routes)
  }

  resolveFencedOwner = (id: string, incarnationId: string) => {
    this.syncCollections()
    return this.attachResolver.resolveTermination(id, incarnationId)
  }

  spawn = async (opts: PtySpawnOptions): Promise<PtySpawnResult> => {
    this.syncCollections()
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

  getVerifiedRoute = (id: string): IPtyProvider | undefined => {
    this.syncCollections()
    return this.attachResolver.getVerifiedRoute(id)
  }

  probe = async (sessionId: string): Promise<boolean | null> => {
    this.syncCollections()
    return await this.livenessResolver.probe(sessionId)
  }

  discoverRoutes = async (): Promise<void> => {
    this.syncCollections()
    await this.attachResolver.discoverRoutes()
  }

  async listProcesses(
    opts?: Parameters<IPtyProvider['listProcesses']>[0]
  ): Promise<PtyProcessInfo[]> {
    this.syncCollections()
    return this.attachResolver.listProcesses(opts)
  }

  async reconcileOnStartup(validWorktreeIds: Set<string>): Promise<{
    alive: string[]
    killed: string[]
  }> {
    this.syncCollections()
    const alive: string[] = []
    const killed: string[] = []
    const aliveProviders = new Map<string, Set<DaemonPtyAdapter>>()
    for (const adapter of this.readDaemonAdapters()) {
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
    this.syncCollections()
    this.attachResolver.recordRoute(sessionId, provider, incarnationId)
    const adapter = this.readDaemonAdapters().find((candidate) => candidate === provider)
    if (adapter) {
      this.livenessResolver.recordRoute(sessionId, adapter, incarnationId)
    }
  }

  forgetRoute(sessionId: string): void {
    this.syncCollections()
    this.attachResolver.forgetRoute(sessionId)
    this.livenessResolver.forgetRoute(sessionId)
  }

  subscribeIdentityChanges(): (() => void)[] {
    this.identityTracking = true
    this.syncCollections()
    return [
      () => {
        this.identityTracking = false
        for (const unsubscribe of this.identityUnsubscribes.splice(0)) {
          unsubscribe()
        }
      }
    ]
  }

  // Why: current stays out of inventory until its spawn probe succeeds, then joins the live collections.
  private syncCollections(): void {
    for (const provider of this.readProviders()) {
      this.attachResolver.admitProvider(provider)
    }
    for (const adapter of this.readDaemonAdapters()) {
      this.livenessResolver.admitProvider(adapter)
      this.subscribeAdapterIdentity(adapter)
    }
  }

  private subscribeAdapterIdentity(adapter: DaemonPtyAdapter): void {
    if (!this.identityTracking || this.identitySubscribed.has(adapter)) {
      return
    }
    this.identitySubscribed.add(adapter)
    if (typeof adapter.onDaemonIdentityChanged !== 'function') {
      return
    }
    this.identityUnsubscribes.push(
      adapter.onDaemonIdentityChanged(() => {
        this.attachResolver.invalidateProvider(adapter)
        this.livenessResolver.invalidateProvider(adapter)
      })
    )
  }
}
