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

  async request(
    current: DaemonPtyAdapter,
    adapters: readonly DaemonPtyAdapter[],
    retiring: boolean,
    payload: PreparedAgentLaunchRequest['payload']
  ): Promise<unknown> {
    if (payload.action === 'prepare') {
      if (retiring) {
        throw new Error('Terminal daemon is decommissioning')
      }
      const prepared = await current.preparedAgentLaunch(payload)
      if (isPreparedAgentLaunchStatus(prepared)) {
        this.routes.set(prepared.daemonGeneration, current)
      }
      return prepared
    }
    const capable = adapters.filter((adapter) => adapter.supportsPreparedAgentLaunches())
    if (payload.action === 'list') {
      const pages = await Promise.all(
        capable.map((adapter) => adapter.preparedAgentLaunch(payload))
      )
      return { pages }
    }
    const generation = payload.identity.daemonGeneration
    let owner = this.routes.get(generation)
    if (owner && !capable.includes(owner)) {
      this.routes.delete(generation)
      owner = undefined
    }
    owner ??= (await this.discover(generation, capable, payload.identity)) ?? undefined
    if (!owner) {
      throw new Error('agent_session_ownership_unknown')
    }
    return owner.preparedAgentLaunch(payload)
  }

  // Concurrent rejoins of one generation share one probe; the first adapter that is that generation wins.
  private discover(
    generation: string,
    capable: readonly DaemonPtyAdapter[],
    identity: PreparedAgentLaunchIdentity
  ): Promise<DaemonPtyAdapter | null> {
    const existing = this.discovering.get(generation)
    if (existing) {
      return existing
    }
    const found = new Promise<DaemonPtyAdapter | null>((resolve) => {
      let remaining = capable.length
      const settle = (adapter: DaemonPtyAdapter | null) => {
        if (adapter) {
          resolve(adapter)
        } else if (--remaining === 0) {
          resolve(null)
        }
      }
      if (remaining === 0) {
        resolve(null)
      }
      for (const adapter of capable) {
        adapter.preparedAgentLaunch({ action: 'status', identity }).then(
          (status) => settle(isPreparedAgentLaunchStatus(status) ? adapter : null),
          // Only the named generation can say it holds no such operation.
          (error: unknown) => settle(isPreparedLaunchOperationUnknown(error) ? adapter : null)
        )
      }
    }).then((adapter) => {
      this.discovering.delete(generation)
      if (adapter) {
        this.routes.set(generation, adapter)
      }
      return adapter
    })
    this.discovering.set(generation, found)
    return found
  }
}

import type { DaemonRouterRetirement } from './daemon-router-retirement'
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
      this.getAllAdapters(),
      this.retirement.admissionClosed,
      payload
    )
  }
}
