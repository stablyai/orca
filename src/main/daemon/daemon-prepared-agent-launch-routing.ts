import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  isPreparedAgentLaunchStatus,
  type PreparedAgentLaunchRequest
} from './prepared-agent-launch-protocol'

export async function routePreparedAgentLaunch(
  current: DaemonPtyAdapter,
  adapters: readonly DaemonPtyAdapter[],
  retiring: boolean,
  payload: PreparedAgentLaunchRequest['payload']
): Promise<unknown> {
  if (payload.action === 'prepare') {
    if (retiring) {
      throw new Error('Terminal daemon is decommissioning')
    }
    return current.preparedAgentLaunch(payload)
  }
  const capable = adapters.filter((adapter) => adapter.supportsPreparedAgentLaunches())
  if (payload.action === 'list') {
    const pages = await Promise.all(capable.map((adapter) => adapter.preparedAgentLaunch(payload)))
    return { pages }
  }
  const identity = payload.identity
  const probed = await Promise.allSettled(
    capable.map(async (adapter) => ({
      adapter,
      status: await adapter.preparedAgentLaunch({ action: 'status', identity })
    }))
  )
  const matches = probed.flatMap((result) =>
    result.status === 'fulfilled' && isPreparedAgentLaunchStatus(result.value.status)
      ? [result.value]
      : []
  )
  if (matches.length !== 1) {
    throw new Error('agent_session_ownership_unknown')
  }
  if (payload.action === 'status') {
    return matches[0].status
  }
  return matches[0].adapter.preparedAgentLaunch(payload)
}

import type { DaemonRouterRetirement } from './daemon-router-retirement'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'

export abstract class DaemonPtyPreparedLaunchRouting {
  abstract readonly retirement: DaemonRouterRetirement
  abstract getCurrentAdapter(): DaemonPtyAdapter
  abstract getAllAdapters(): readonly DaemonPtyAdapter[]
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
    return routePreparedAgentLaunch(
      this.getCurrentAdapter(),
      this.getAllAdapters(),
      this.retirement.admissionClosed,
      payload
    )
  }
}
