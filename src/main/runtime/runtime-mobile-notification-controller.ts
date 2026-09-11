import { reserveNotificationCooldown } from '../../shared/notification-burst-cooldown'
import type { AgentStatusState } from '../../shared/agent-status-types'
import type {
  MobilePushRegisterInput,
  MobilePushRegisterResult
} from '../../shared/mobile-push-contract'
import { MobileNotificationReplayBuffer } from './mobile-notification-replay'
import { notifyRuntimeListeners } from './runtime-async-boundaries'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import {
  MobileNotificationDismissalStore,
  type DeliveredNotificationIdentity
} from './mobile-notification-dismissal-store'

export type MobileNotificationDispatchEvent = {
  type: 'notification'
  legacySocketAllowed?: boolean
  desktopAllowed?: boolean
  desktopAway?: boolean
  emittedAt?: number
  source: 'agent-task-complete' | 'terminal-bell' | 'test' | 'plugin'
  title: string
  body: string
  worktreeId?: string
  paneKey?: string
  notificationId?: string
  notificationSeq?: number
  notificationEpoch?: string
  // Why: background push must tell "needs input" from "finished" without re-deriving
  // it from the title. Optional and additive — old clients ignore it.
  agentState?: AgentStatusState
}

export type MobileNotificationDismissEvent = {
  type: 'dismiss'
  notificationId: string
  notificationSeq?: number
  notificationEpoch?: string
}

export type MobileNotificationEvent =
  | MobileNotificationDispatchEvent
  | MobileNotificationDismissEvent

/** The desktop push service, once it exists; absent on hosts that never started one. */
export type MobilePushRegistrar = {
  register(input: MobilePushRegisterInput): Promise<MobilePushRegisterResult>
  unregister(deviceId: string): Promise<{ unregistered: boolean }>
}

export class RuntimeMobileNotificationController {
  private readonly listeners = new Set<(event: MobileNotificationEvent) => void>()
  private readonly legacyCooldown = new Map<string, number>()
  private readonly replay = new MobileNotificationReplayBuffer()
  private pushRegistrar: MobilePushRegistrar | null = null
  private dismissalStore: MobileNotificationDismissalStore | null = null

  configureDismissalStore(userDataPath: string): void {
    this.dismissalStore = new MobileNotificationDismissalStore(userDataPath)
  }

  reconcileDismissedPushes(
    delivered: readonly DeliveredNotificationIdentity[]
  ): DeliveredNotificationIdentity[] {
    return this.dismissalStore?.reconcile(delivered) ?? []
  }

  setPushRegistrar(registrar: MobilePushRegistrar | null): void {
    this.pushRegistrar = registrar
  }

  async registerPushDevice(input: MobilePushRegisterInput): Promise<MobilePushRegisterResult> {
    return (
      (await this.pushRegistrar?.register(input)) ?? {
        registered: false,
        reason: 'gateway_unreachable'
      }
    )
  }

  async unregisterPushDevice(deviceId: string): Promise<{ unregistered: boolean }> {
    return (await this.pushRegistrar?.unregister(deviceId)) ?? { unregistered: false }
  }

  onDispatched(listener: (event: MobileNotificationEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getListenerCount(): number {
    return this.listeners.size
  }

  dispatch(event: MobileNotificationEvent): void {
    if (event.type === 'notification') {
      // Decide once before recording so reconnect and buffer eviction cannot reset cooldown.
      const legacySocketAllowed =
        event.desktopAllowed !== false &&
        (event.emittedAt === undefined ||
          reserveNotificationCooldown(
            this.legacyCooldown,
            event.worktreeId ?? 'global',
            event.emittedAt
          ))
      event = {
        ...event,
        legacySocketAllowed,
        desktopAway: getRuntimeDesktopSurface().isAwayForMobileNotifications?.()
      }
    }
    const seq = this.replay.record(event)
    try {
      this.dismissalStore?.record({
        ...event,
        notificationSeq: seq,
        notificationEpoch: this.replay.epoch
      })
    } catch {
      console.warn('[notifications] Could not persist dismissal recovery state')
    }
    notifyRuntimeListeners(
      this.listeners,
      (listener) =>
        listener({
          ...event,
          notificationSeq: seq,
          notificationEpoch: this.replay.epoch
        }),
      'mobile-notification'
    )
  }

  getMissedSince(lastSeenSeq: number, epoch?: string) {
    return this.replay.getMissedSince(lastSeenSeq, epoch)
  }

  getEpoch(): string {
    return this.replay.epoch
  }

  dismiss(notificationId: string): void {
    this.dispatch({ type: 'dismiss', notificationId })
  }

  async dispatchPlugin(input: {
    pluginId: string
    title: string
    body?: string
  }): Promise<{ delivered: boolean }> {
    const title = `${input.pluginId}: ${input.title}`
    const body = input.body ?? ''
    let delivered = false
    try {
      delivered = getRuntimeDesktopSurface().showNotification({ title, body })
    } catch {
      // Headless runtimes still relay the notification to mobile clients.
    }
    this.dispatch({ type: 'notification', source: 'plugin', title, body })
    return { delivered }
  }
}
