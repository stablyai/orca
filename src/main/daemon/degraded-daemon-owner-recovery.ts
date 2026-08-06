import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../providers/types'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

export class DegradedDaemonOwnerRecovery {
  private readonly attachResolver: DaemonSessionOwnerResolver<IPtyProvider>
  private readonly livenessResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>

  constructor(
    providers: readonly IPtyProvider[],
    private readonly daemonAdapters: readonly DaemonPtyAdapter[],
    routes: Map<string, IPtyProvider>,
    private readonly spawnFresh: (opts: PtySpawnOptions) => Promise<PtySpawnResult>
  ) {
    this.attachResolver = new DaemonSessionOwnerResolver(providers, routes)
    this.livenessResolver = new DaemonSessionOwnerResolver(daemonAdapters, routes)
  }

  spawn = async (opts: PtySpawnOptions): Promise<PtySpawnResult> => {
    return opts.attachOnly && opts.sessionId
      ? await this.attachResolver.spawnAttachOnly({ ...opts, sessionId: opts.sessionId })
      : await this.spawnFresh(opts)
  }

  probe = async (sessionId: string): Promise<boolean | null> =>
    await this.livenessResolver.probe(sessionId)

  discoverRoutes = async (): Promise<void> => await this.attachResolver.discoverRoutes()

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

  recordRoute(sessionId: string, provider: IPtyProvider): void {
    this.attachResolver.recordRoute(sessionId, provider)
    if (this.daemonAdapters.includes(provider as DaemonPtyAdapter)) {
      this.livenessResolver.recordRoute(sessionId, provider as DaemonPtyAdapter)
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
