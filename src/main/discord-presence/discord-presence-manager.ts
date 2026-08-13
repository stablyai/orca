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
  /** Override the throttle interval (ms) for tests. */
  throttleIntervalMs?: number
}

const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 30_000

export class DiscordPresenceManager {
  private deps: DiscordPresenceManagerDeps
  private unsubscribe: (() => void) | null = null
  private throttle: ReturnType<typeof createPresenceThrottle>
  private connected = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = RECONNECT_BASE_DELAY_MS
  private stopped = false

  constructor(deps: DiscordPresenceManagerDeps) {
    this.deps = deps
    this.throttle = createPresenceThrottle(
      this.publish.bind(this),
      deps.throttleIntervalMs
    )
  }

  start(): void {
    console.log('[discord-presence] start() called')
    if (this.unsubscribe) return // already started
    this.stopped = false
    this.unsubscribe = this.deps.subscribeChanges(() => this.onChange())
    this.deps.client.onDisconnect(() => this.onDisconnect())
    console.log('[discord-presence] subscribed to status changes')
    void this.connectAndPublish()
  }

  /** Force an immediate re-evaluation (e.g. when the enabled toggle changes). */
  refresh(): void {
    this.onChange()
  }

  stop(): void {
    console.log('[discord-presence] stop() called')
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.deps.client.disconnect()
    this.connected = false
  }

  private async connectAndPublish(): Promise<void> {
    if (!this.deps.isEnabled()) {
      console.log('[discord-presence] feature disabled, skipping connect')
      return
    }
    try {
      console.log('[discord-presence] connecting to Discord IPC...')
      await this.deps.client.connect()
      this.connected = true
      this.reconnectDelay = RECONNECT_BASE_DELAY_MS
      console.log('[discord-presence] connected, publishing initial state')
      this.onChange()
    } catch (err) {
      console.error('[discord-presence] connect failed:', err)
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    console.log('[discord-presence] reconnect in', this.reconnectDelay, 'ms')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_DELAY_MS)
      void this.connectAndPublish()
    }, this.reconnectDelay)
  }

  private onDisconnect(): void {
    console.log('[discord-presence] disconnected')
    if (!this.connected) return
    this.connected = false
    this.scheduleReconnect()
  }

  private onChange(): void {
    const enabled = this.deps.isEnabled()
    console.log('[discord-presence] onChange called, isEnabled:', enabled, 'connected:', this.connected)
    if (!enabled) {
      if (this.connected) {
        this.deps.client.setActivity(null).catch(() => {})
      }
      return
    }
    if (!this.connected) {
      void this.connectAndPublish()
      return
    }
    const snapshot = aggregateAgentStatus(this.deps.getSnapshot())
    console.log('[discord-presence] snapshot:', JSON.stringify(snapshot))
    const activity = buildDiscordActivity(snapshot, this.deps.assetKey)
    console.log('[discord-presence] activity:', JSON.stringify(activity))
    this.throttle(activity)
  }

  private publish(activity: ReturnType<typeof buildDiscordActivity>): void {
    console.log('[discord-presence] publish:', activity === null ? 'clear' : activity.details)
    this.deps.client.setActivity(activity).catch((err) => {
      console.error('[discord-presence] publish failed:', err)
    })
  }
}