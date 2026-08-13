import { aggregateAgentStatus, buildDiscordActivity } from './discord-presence-activity'
import { createPresenceThrottle } from './discord-presence-throttle'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { DiscordRpcClient } from './discord-rpc-client'

export type DiscordPresenceManagerDeps = {
  getSnapshot: () => AgentStatusIpcPayload[]
  subscribeChanges: (cb: () => void) => () => void
  client: DiscordRpcClient
  isEnabled: () => boolean
  assetKey: string
}

export class DiscordPresenceManager {
  private deps: DiscordPresenceManagerDeps
  private unsubscribe: (() => void) | null = null
  private throttle = createPresenceThrottle(this.publish.bind(this))

  constructor(deps: DiscordPresenceManagerDeps) {
    this.deps = deps
  }

  start(): void {
    if (this.unsubscribe) return // already started
    this.unsubscribe = this.deps.subscribeChanges(() => this.onChange())
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.deps.client.disconnect()
  }

  private onChange(): void {
    if (!this.deps.isEnabled()) {
      this.deps.client.setActivity(null)
      return
    }
    const snapshot = aggregateAgentStatus(this.deps.getSnapshot())
    const activity = buildDiscordActivity(snapshot, this.deps.assetKey)
    this.throttle(activity)
  }

  private publish(activity: ReturnType<typeof buildDiscordActivity>): void {
    this.deps.client.setActivity(activity)
  }
}