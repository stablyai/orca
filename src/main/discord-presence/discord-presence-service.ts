import type { DiscordPresenceStatus } from '../../shared/discord-presence-status'
import { AgentAwakeStatusLease, type AgentAwakeStatus } from '../agent-awake-status-lease'
import type {
  DiscordActivity,
  DiscordIpcConnectOptions,
  DiscordIpcConnection
} from './discord-ipc-client'
import { buildDiscordPresenceActivity } from './discord-presence-activity'

// Why: Discord accepts 5 activity updates per 20s; one every 4s never trips the limit.
export const DISCORD_PRESENCE_MIN_UPDATE_INTERVAL_MS = 4_000
// Why: Discord being closed is the normal case, so probing must stay cheap and infrequent.
export const DISCORD_PRESENCE_RETRY_INTERVAL_MS = 15_000

type Connect = (
  options: Pick<DiscordIpcConnectOptions, 'onClosed'>
) => Promise<DiscordIpcConnection>
type Translate = Parameters<typeof buildDiscordPresenceActivity>[1]

type DiscordPresenceServiceOptions = {
  connect: Connect
  translate: Translate
  now?: () => number
  logger?: Pick<Console, 'debug'>
}

function isWaitingForUser(status: AgentAwakeStatus): boolean {
  return (
    status.observedInCurrentRuntime && (status.state === 'blocked' || status.state === 'waiting')
  )
}

export class DiscordPresenceService {
  private enabled = false
  private status: DiscordPresenceStatus = 'off'
  private connection: DiscordIpcConnection | null = null
  /** Bumped on every disable so a connect that resolves late is discarded. */
  private generation = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private updateTimer: ReturnType<typeof setTimeout> | null = null
  private lastSentAt = Number.NEGATIVE_INFINITY
  private lastSentActivityJson: string | null = null
  private statuses: AgentAwakeStatus[] = []
  private readonly workingLease: AgentAwakeStatusLease
  private readonly sessionStartedAt: number
  private readonly listeners = new Set<(status: DiscordPresenceStatus) => void>()
  private readonly connect: Connect
  private readonly translate: Translate
  private readonly now: () => number
  private readonly logger: Pick<Console, 'debug'>

  constructor(options: DiscordPresenceServiceOptions) {
    this.connect = options.connect
    this.translate = options.translate
    this.now = options.now ?? Date.now
    this.logger = options.logger ?? console
    this.sessionStartedAt = this.now()
    // Why: reuse the awake lease so a working row that stops reporting ages out after the same window.
    this.workingLease = new AgentAwakeStatusLease(this.now, () => this.scheduleActivityUpdate())
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return
    }
    this.enabled = enabled
    if (enabled) {
      this.startConnecting()
    } else {
      this.disconnect()
    }
  }

  setStatuses(statuses: AgentAwakeStatus[]): void {
    this.statuses = statuses
    this.workingLease.replace(statuses)
    this.scheduleActivityUpdate()
  }

  observeStatusFreshness(status: AgentAwakeStatus): void {
    if (this.workingLease.renew(status)) {
      this.scheduleActivityUpdate()
    }
  }

  getStatus(): DiscordPresenceStatus {
    return this.status
  }

  subscribe(listener: (status: DiscordPresenceStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.listeners.clear()
    this.workingLease.dispose()
    this.disconnect()
  }

  private startConnecting(): void {
    this.clearRetryTimer()
    this.setStatus('connecting')
    const generation = this.generation
    this.connect({ onClosed: () => this.handleConnectionClosed(generation) }).then(
      (connection) => {
        if (generation !== this.generation || !this.enabled) {
          connection.close()
          return
        }
        this.connection = connection
        this.lastSentActivityJson = null
        this.setStatus('connected')
        this.scheduleActivityUpdate()
      },
      (error: unknown) => {
        if (generation !== this.generation || !this.enabled) {
          return
        }
        this.logger.debug('[discord-presence] discord not reachable', error)
        this.setStatus('unavailable')
        this.scheduleRetry()
      }
    )
  }

  private handleConnectionClosed(generation: number): void {
    if (generation !== this.generation) {
      return
    }
    this.connection = null
    this.clearUpdateTimer()
    if (this.enabled) {
      this.setStatus('unavailable')
      this.scheduleRetry()
    }
  }

  private disconnect(): void {
    this.generation += 1
    this.clearRetryTimer()
    this.clearUpdateTimer()
    const connection = this.connection
    this.connection = null
    this.lastSentActivityJson = null
    if (connection) {
      connection.setActivity(null)
      connection.close()
    }
    this.setStatus('off')
  }

  private scheduleRetry(): void {
    this.clearRetryTimer()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.enabled && !this.connection) {
        this.startConnecting()
      }
    }, DISCORD_PRESENCE_RETRY_INTERVAL_MS)
    this.retryTimer.unref?.()
  }

  private scheduleActivityUpdate(): void {
    if (!this.connection || this.updateTimer !== null) {
      return
    }
    const delay = Math.max(
      0,
      this.lastSentAt + DISCORD_PRESENCE_MIN_UPDATE_INTERVAL_MS - this.now()
    )
    if (delay === 0) {
      this.sendActivity()
      return
    }
    // Why: coalesce bursts of hook events into the latest snapshot instead of queueing each one.
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null
      this.sendActivity()
    }, delay)
    this.updateTimer.unref?.()
  }

  private sendActivity(): void {
    if (!this.connection) {
      return
    }
    const activity = this.buildActivity()
    const json = JSON.stringify(activity)
    if (json === this.lastSentActivityJson) {
      return
    }
    this.connection.setActivity(activity)
    this.lastSentActivityJson = json
    this.lastSentAt = this.now()
  }

  private buildActivity(): DiscordActivity {
    return buildDiscordPresenceActivity(
      {
        workingAgentCount: this.workingLease.countEligible(),
        waitingAgentCount: this.statuses.filter(isWaitingForUser).length,
        sessionStartedAt: this.sessionStartedAt
      },
      this.translate
    )
  }

  private setStatus(status: DiscordPresenceStatus): void {
    if (this.status === status) {
      return
    }
    this.status = status
    for (const listener of this.listeners) {
      listener(status)
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private clearUpdateTimer(): void {
    if (this.updateTimer !== null) {
      clearTimeout(this.updateTimer)
      this.updateTimer = null
    }
  }
}
