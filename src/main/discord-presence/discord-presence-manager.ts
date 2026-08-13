import { aggregateAgentStatus, buildDiscordActivity } from './discord-presence-activity'
import type { DiscordActivity } from './discord-presence-activity'
import { createPresenceThrottle } from './discord-presence-throttle'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { DiscordRpcClient } from './discord-rpc-client'
import { DiscordHandshakeRejectedError } from './discord-rpc-client'

export type DiscordPresenceManagerDeps = {
  getSnapshot: () => AgentStatusIpcPayload[]
  subscribeChanges: (cb: () => void) => () => void
  client: DiscordRpcClient
  isEnabled: () => boolean
  assetKey: string
  /** Live terminal pane count (agents + plain shells). Optional: defaults to 0. */
  getActiveTerminalCount?: () => number
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
  private handshakeFailed = false
  private connecting = false

  constructor(deps: DiscordPresenceManagerDeps) {
    this.deps = deps
    this.throttle = createPresenceThrottle(
      this.publish.bind(this),
      deps.throttleIntervalMs
    )
  }

  start(): void {
    if (this.unsubscribe) return // already started
    this.stopped = false
    this.handshakeFailed = false
    this.unsubscribe = this.deps.subscribeChanges(() => this.onChange())
    this.deps.client.onDisconnect(() => this.onDisconnect())
    void this.connectAndPublish()
  }

  /** Force an immediate re-evaluation (e.g. when the enabled toggle changes). */
  refresh(): void {
    this.onChange()
  }

  stop(): void {
    this.stopped = true
    this.throttle.cancel()
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
    if (!this.deps.isEnabled()) return
    if (this.connecting) return
    this.connecting = true
    try {
      console.log('[discord-presence] connecting to Discord IPC...')
      await this.deps.client.connect()
      this.connected = true
      this.reconnectDelay = RECONNECT_BASE_DELAY_MS
      console.log('[discord-presence] connected, publishing initial state')
      this.onChange()
    } catch (err) {
      if (err instanceof DiscordHandshakeRejectedError) {
        this.handshakeFailed = true
        console.error('[discord-presence] handshake rejected — set ORCA_DISCORD_CLIENT_ID to a valid Discord Application ID and restart Orca')
        return
      }
      console.error('[discord-presence] connect failed:', err)
      this.scheduleReconnect()
    } finally {
      this.connecting = false
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
    if (!enabled) {
      if (this.connected) {
        this.deps.client.setActivity(null).catch(() => {})
      }
      return
    }
    if (!this.connected) {
      if (!this.handshakeFailed && !this.reconnectTimer) void this.connectAndPublish()
      return
    }
    const snapshot = {
      ...aggregateAgentStatus(this.deps.getSnapshot()),
      activeTerminals: this.deps.getActiveTerminalCount?.() ?? 0
    }
    const activity = buildDiscordActivity(snapshot, this.deps.assetKey)
    this.throttle(activity)
  }

  private publish(activity: DiscordActivity | null): void {
    this.deps.client.setActivity(activity).catch((err) => {
      console.error('[discord-presence] publish failed:', err)
    })
  }
}