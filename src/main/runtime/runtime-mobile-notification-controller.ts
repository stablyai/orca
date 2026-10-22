import { reserveNotificationCooldown } from '../../shared/notification-burst-cooldown'
import type { AgentStatusState } from '../../shared/agent-status-types'
import {
  agentSessionAttentionSubjectPrefix,
  attentionOriginWasRead,
  type StructuredAttentionOrigin,
  type StructuredAttentionRead,
  type StructuredAttentionState
} from '../../shared/agent-session-attention'
import type {
  MobilePushTestResult,
  MobilePushRegisterInput,
  MobilePushRegisterResult
} from '../../shared/mobile-push-contract'
import { MobileNotificationReplayBuffer } from './mobile-notification-replay'
import { notifyRuntimeListeners } from './runtime-async-boundaries'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import { MobileNotificationDismissalStore } from './mobile-notification-dismissal-store'
import { DesktopClientPresenceTracker } from './desktop-client-presence-tracker'
import type { DeliveredNotificationIdentity } from '../../shared/mobile-notification-identity'

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
  /** See `NotificationDispatchRequest.executionHost`; old phones ignore it and open the desktop's. */
  executionHost?: `runtime:${string}`
  notificationId?: string
  notificationSeq?: number
  notificationEpoch?: string
  // Why: background push must tell "needs input" from "finished" without re-deriving
  // it from the title. Optional and additive — old clients ignore it.
  agentState?: AgentStatusState
  /** See `NotificationDispatchRequest.attentionKey`: cooldowns key on it instead of the workspace. */
  attentionKey?: string
  structuredOrigin?: StructuredAttentionOrigin
}

export type MobileNotificationDismissEvent = {
  type: 'dismiss'
  notificationId: string
  notificationSeq?: number
  notificationEpoch?: string
  dismissedDelivery?: DeliveredNotificationIdentity
}

export type MobileNotificationEvent =
  | MobileNotificationDispatchEvent
  | MobileNotificationDismissEvent

/** The desktop push service, once it exists; absent on hosts that never started one. */
export type MobilePushRegistrar = {
  test(deviceId: string): Promise<MobilePushTestResult>
  register(input: MobilePushRegisterInput): Promise<MobilePushRegisterResult>
  unregister(deviceId: string): Promise<{ unregistered: boolean }>
}

export class RuntimeMobileNotificationController {
  private readonly listeners = new Set<(event: MobileNotificationEvent) => void>()
  private readonly legacyCooldown = new Map<string, number>()
  private readonly replay = new MobileNotificationReplayBuffer()
  private pushRegistrar: MobilePushRegistrar | null = null
  private dismissalStore: MobileNotificationDismissalStore | null = null
  private readonly desktopClients = new DesktopClientPresenceTracker()

  configureDismissalStore(userDataPath: string): void {
    this.dismissalStore = new MobileNotificationDismissalStore(userDataPath)
  }

  /** Waits for the pending dismissal write without closing the store. */
  flushDismissals(): Promise<void> {
    return this.dismissalStore?.flush() ?? Promise.resolve()
  }

  closeDismissals(): Promise<void> {
    return this.dismissalStore?.close() ?? Promise.resolve()
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

  async testPushDevice(deviceId: string): Promise<MobilePushTestResult> {
    return (await this.pushRegistrar?.test(deviceId)) ?? { accepted: false, reason: 'unavailable' }
  }

  async unregisterPushDevice(deviceId: string): Promise<{ unregistered: boolean }> {
    return (await this.pushRegistrar?.unregister(deviceId)) ?? { unregistered: false }
  }

  /** `bindForget` runs for a connection without a live report, before it is recorded. */
  reportDesktopClientPresence(
    connectionId: string,
    away: boolean,
    bindForget: (forget: () => void) => void
  ): void {
    if (!this.desktopClients.has(connectionId)) {
      bindForget(() => this.desktopClients.forget(connectionId))
    }
    this.desktopClients.report(connectionId, away, Date.now())
  }

  // Why: undefined means unknown and must never silence a phone; only a fresh report or the local
  // idle state proves someone is at a desktop. A host with no desktop of its own (orca serve) has
  // only its attached desktops to ask, so their silence is away rather than unknown (#31570).
  private resolveDesktopAway(): boolean | undefined {
    if (this.desktopClients.anyPresent(Date.now())) {
      return false
    }
    const surface = getRuntimeDesktopSurface()
    return surface.isAwayForMobileNotifications ? surface.isAwayForMobileNotifications() : true
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
            event.attentionKey ?? event.worktreeId ?? 'global',
            event.emittedAt
          ))
      event = {
        ...event,
        legacySocketAllowed,
        desktopAway: this.resolveDesktopAway()
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

  private retireDelivery(delivery: DeliveredNotificationIdentity): void {
    this.dispatch({
      type: 'dismiss',
      notificationId: delivery.notificationId,
      dismissedDelivery: {
        notificationId: delivery.notificationId,
        notificationEpoch: delivery.notificationEpoch,
        notificationSeq: delivery.notificationSeq
      }
    })
  }

  retireStructuredAttention(read: StructuredAttentionRead): void {
    for (const delivery of this.dismissalStore?.liveDeliveries() ?? []) {
      if (attentionOriginWasRead(delivery.structuredOrigin, read)) {
        this.retireDelivery(delivery)
      }
    }
  }

  reconcileStructuredPromptAttention(state: StructuredAttentionState): void {
    const prefix = agentSessionAttentionSubjectPrefix(state.scope, state.sessionId)
    const pending = new Set(state.pendingPromptIds)
    for (const delivery of this.dismissalStore?.liveDeliveries(prefix) ?? []) {
      const cause = delivery.structuredOrigin?.cause
      if (cause?.kind === 'prompt' && !pending.has(cause.promptId)) {
        this.retireDelivery(delivery)
      }
    }
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
