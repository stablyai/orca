import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  isPreparedAgentLaunchStatus,
  type PreparedAgentLaunchIdentity,
  type PreparedAgentLaunchRequest
} from './prepared-agent-launch-protocol'
import { isPreparedLaunchOperationUnknown } from '../../shared/prepared-agent-launch'

/** Each daemon generation is one owner: route its operations directly once known, like session owner routes. */
export class PreparedAgentLaunchRoutes {
  private readonly routes = new Map<string, DaemonPtyAdapter>()
  private readonly discovering = new Map<string, Promise<DaemonPtyAdapter | null>>()
  /** Bumped when an adapter's routes are forgotten, so a discovery begun before cannot reinstall one. */
  private readonly epochs = new WeakMap<DaemonPtyAdapter, number>()
  private readonly watched = new WeakSet<DaemonPtyAdapter>()

  async request(
    current: DaemonPtyAdapter,
    adapters: () => readonly DaemonPtyAdapter[],
    retiring: boolean,
    payload: PreparedAgentLaunchRequest['payload']
  ): Promise<unknown> {
    if (payload.action === 'prepare') {
      if (retiring) {
        throw new Error('Terminal daemon is decommissioning')
      }
      const epoch = this.epochOf(current)
      const prepared = await current.preparedAgentLaunch(payload)
      if (isPreparedAgentLaunchStatus(prepared)) {
        this.install(prepared.daemonGeneration, current, epoch)
      }
      return prepared
    }
    if (payload.action === 'list') {
      const pages = await Promise.all(
        capableOf(adapters()).map((adapter) => adapter.preparedAgentLaunch(payload))
      )
      return { pages }
    }
    const generation = payload.identity.daemonGeneration
    // A known generation is one map read: lifecycle eviction keeps routes current, so no list is built.
    const owner =
      this.routes.get(generation) ?? (await this.discover(generation, adapters, payload.identity))
    if (!owner) {
      throw new Error('agent_session_ownership_unknown')
    }
    return owner.preparedAgentLaunch(payload)
  }

  /** A retired adapter, or a replaced daemon behind it, addresses none of its old generations. */
  forgetAdapter(adapter: DaemonPtyAdapter): void {
    this.epochs.set(adapter, this.epochOf(adapter) + 1)
    for (const [generation, owner] of this.routes) {
      if (owner === adapter) {
        this.routes.delete(generation)
      }
    }
  }

  private epochOf(adapter: DaemonPtyAdapter): number {
    return this.epochs.get(adapter) ?? 0
  }

  private install(generation: string, adapter: DaemonPtyAdapter, epoch: number): void {
    if (this.epochOf(adapter) !== epoch) {
      return
    }
    this.routes.set(generation, adapter)
    if (!this.watched.has(adapter)) {
      this.watched.add(adapter)
      adapter.onDaemonIdentityChanged(() => this.forgetAdapter(adapter))
    }
  }

  // Concurrent rejoins of one generation share one probe; the first adapter that is that generation wins.
  private discover(
    generation: string,
    adapters: () => readonly DaemonPtyAdapter[],
    identity: PreparedAgentLaunchIdentity
  ): Promise<DaemonPtyAdapter | null> {
    const existing = this.discovering.get(generation)
    if (existing) {
      return existing
    }
    const capable = capableOf(adapters())
    const found = new Promise<{ adapter: DaemonPtyAdapter; epoch: number } | null>((resolve) => {
      let remaining = capable.length
      const settle = (match: { adapter: DaemonPtyAdapter; epoch: number } | null) => {
        if (match) {
          resolve(match)
        } else if (--remaining === 0) {
          resolve(null)
        }
      }
      if (remaining === 0) {
        resolve(null)
      }
      for (const adapter of capable) {
        const match = { adapter, epoch: this.epochOf(adapter) }
        adapter.preparedAgentLaunch({ action: 'status', identity }).then(
          (status) => settle(isPreparedAgentLaunchStatus(status) ? match : null),
          // Only the named generation can say it holds no such operation.
          (error: unknown) => settle(isPreparedLaunchOperationUnknown(error) ? match : null)
        )
      }
    }).then((match) => {
      this.discovering.delete(generation)
      if (match) {
        this.install(generation, match.adapter, match.epoch)
      }
      return match?.adapter ?? null
    })
    this.discovering.set(generation, found)
    return found
  }
}

function capableOf(adapters: readonly DaemonPtyAdapter[]): DaemonPtyAdapter[] {
  return adapters.filter((adapter) => adapter.supportsPreparedAgentLaunches())
}

import type { DaemonRouterRetirement } from './daemon-router-retirement'
import type { ExitedLegacyVerdict } from './daemon-router-exited-legacy'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'

export abstract class DaemonPtyPreparedLaunchRouting {
  abstract readonly retirement: DaemonRouterRetirement
  abstract getCurrentAdapter(): DaemonPtyAdapter
  abstract getAllAdapters(): readonly DaemonPtyAdapter[]
  private readonly preparedLaunchRoutes = new PreparedAgentLaunchRoutes()
  prepareAgentLaunchSpawn(options: PtySpawnOptions) {
    if (this.retirement.admissionClosed) {
      throw new Error('Terminal daemon is decommissioning')
    }
    return this.getCurrentAdapter().prepareAgentLaunchSpawn(options)
  }

  supportsPreparedAgentLaunches(): boolean {
    return this.getCurrentAdapter().supportsPreparedAgentLaunches()
  }

  onPreparedLaunchReconnect(listener: () => void): () => void {
    const unsubscribers = this.getAllAdapters().map((adapter) =>
      adapter.onPreparedLaunchReconnect(listener)
    )
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }

  preparedAgentLaunch(payload: PreparedAgentLaunchRequest['payload']): Promise<unknown> {
    return this.preparedLaunchRoutes.request(
      this.getCurrentAdapter(),
      () => this.getAllAdapters(),
      this.retirement.admissionClosed,
      payload
    )
  }

  /** A legacy daemon proven exited takes its prepared-launch routes with it. */
  protected forgetRetiredPreparedLaunchOwner(
    adapter: DaemonPtyAdapter,
    verdict: ExitedLegacyVerdict
  ): ExitedLegacyVerdict {
    if (verdict === 'retired') {
      this.preparedLaunchRoutes.forgetAdapter(adapter)
    }
    return verdict
  }
}
