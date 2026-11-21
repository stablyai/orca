import { agentSessionExecutionLocationsEqual } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  NotificationAttentionReadFrontiers,
  notificationWasAcknowledged
} from '../../../../shared/notifications/notification-attention-acknowledgement'
import type {
  NotificationAttentionAcknowledgement,
  NotificationSettings,
  RetainedAgentAttention
} from '../../../../shared/notifications/notification-settings-types'
import { reserveNotificationCooldown } from '../../../../shared/notifications/notification-burst-cooldown'
import type { StructuredAttentionState } from '../../../../shared/agent-session/view/agent-session-attention'
import type {
  MobilePushTestResult,
  MobilePushRegisterInput,
  MobilePushRegisterResult
} from '../../../../shared/notifications/mobile-push-contract'
import type {
  MobileNotificationDispatchEvent,
  MobileNotificationEvent,
  MobilePushRegistrar,
  OwnerNotice
} from './mobile-notification-events'
import { MobileNotificationReplayBuffer } from './mobile-notification-replay'
// Shared contract, not the dispatcher: phones typecheck this file and must not pull in Node timers.
import type { NotificationPushCoverageRequest as PushCoverageRequest } from '../../../../shared/rpc-contract/notifications/notifications-params'
import { notifyRuntimeListeners } from '../../events/runtime-listener-delivery'
import { getRuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'
import { MobileNotificationDismissalStore } from './mobile-notification-dismissal-store'
import { DesktopClientPresenceTracker } from './desktop-client-presence-tracker'
import type { DeliveredNotificationIdentity } from '../../../../shared/notifications/mobile-notification-identity'

export type {
  MobileNotificationDispatchEvent,
  MobileNotificationDismissEvent,
  MobileNotificationEvent,
  MobilePushRegistrar,
  OwnerNotice
} from './mobile-notification-events'

export class RuntimeMobileNotificationController {
  private readonly ownerNoticeCooldown = new Map<string, number>()
  private readonly attentionReads = new NotificationAttentionReadFrontiers()
  private readonly listeners = new Set<(event: MobileNotificationEvent) => void>()
  private readonly legacyCooldown = new Map<string, number>()
  private readonly replay = new MobileNotificationReplayBuffer()
  private pushRegistrar: MobilePushRegistrar | null = null
  private dismissalStore: MobileNotificationDismissalStore | null = null
  private readonly desktopClients = new DesktopClientPresenceTracker()

  constructor(
    private readonly attentionChanged?: (id: string, notice: RetainedAgentAttention | null) => void
  ) {}

  getRetainedAgentAttention(): RetainedAgentAttention[] {
    return this.replay.retainedAgentAttention()
  }

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

  /** The subset of these phones this host pushes itself; empty when it pushes none. */
  async coveredPushTokenDigests(request: PushCoverageRequest): Promise<string[]> {
    return (await this.pushRegistrar?.coveredTokenDigests(request)) ?? []
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

  // Unknown must not silence phones; require fresh desktop/local activity. Headless serves use attached desktops, whose silence means away (#31570).
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
      if (this.attentionReads.covers({ ...event, origin: event.structuredOrigin })) {
        return
      }
      // Decide once before recording so reconnect and buffer eviction cannot reset cooldown.
      const legacySocketAllowed =
        event.desktopAllowed !== false &&
        (event.emittedAt === undefined ||
          reserveNotificationCooldown(
            this.legacyCooldown,
            JSON.stringify([
              event.executionHost,
              event.attentionKey ?? event.worktreeId ?? 'global'
            ]),
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
    const retained = this.replay.retainedNotification(notificationId)
    if (retained?.type === 'notification') {
      this.replay.acknowledge(retained)
      this.dispatch({ type: 'dismiss', notificationId })
      this.attentionChanged?.(notificationId, null)
      return
    }
    // Reads rebuild ids for alerts that never went out (chat panes, silenced workers); each would cost a silent push.
    if (this.dismissalStore && !this.dismissalStore.hasLiveDelivery(notificationId)) {
      return
    }
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

  acknowledgeAttention(
    acknowledgement: NotificationAttentionAcknowledgement,
    executionHost?: MobileNotificationDispatchEvent['executionHost']
  ): void {
    this.attentionReads.accept(acknowledgement, executionHost)
    for (const delivery of this.dismissalStore?.liveDeliveries() ?? []) {
      if (
        notificationWasAcknowledged(
          { ...delivery, origin: delivery.structuredOrigin },
          acknowledgement,
          executionHost
        )
      ) {
        this.retireDelivery(delivery)
      }
    }
  }

  reconcileStructuredPromptAttention(state: StructuredAttentionState): void {
    const pending = new Set(state.pendingPromptIds)
    for (const delivery of this.dismissalStore?.liveDeliveries() ?? []) {
      const origin = delivery.structuredOrigin
      if (
        origin?.cause.kind === 'prompt' &&
        origin.sessionId === state.sessionId &&
        agentSessionExecutionLocationsEqual(origin.scope, state.scope) &&
        delivery.executionHost === state.executionHost &&
        !pending.has(origin.cause.promptId)
      ) {
        this.retireDelivery(delivery)
      }
    }
  }

  reconcileMailboxAttention(id: string, event: MobileNotificationDispatchEvent | null): void {
    const previous = this.replay.retainedNotification(id)
    if (this.replay.acknowledged(id, event)) {
      return
    }
    if (!event) {
      if (previous) {
        this.dispatch({ type: 'dismiss', notificationId: id })
        this.attentionChanged?.(id, null)
      }
      return
    }
    if (
      previous?.type === 'notification' &&
      previous.title === event.title &&
      previous.body === event.body
    ) {
      return
    }
    this.dispatch({ ...event, notificationId: id })
    this.attentionChanged?.(id, {
      notificationId: id,
      title: event.title,
      body: event.body,
      worktreeId: event.worktreeId,
      paneKey: event.paneKey
    })
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

  /**
   * A banner here and a push to phones, under the notifications switch, once per cooldown for each id.
   * Phones get the 'plugin' source, which every gateway takes and which carries no agent state.
   */
  dispatchOwnerNotice(
    notice: OwnerNotice,
    settings: Pick<NotificationSettings, 'enabled'> | undefined
  ): void {
    const now = Date.now()
    if (
      settings?.enabled === false ||
      !reserveNotificationCooldown(this.ownerNoticeCooldown, notice.id, now)
    ) {
      return
    }
    const { id, title, body, worktreeId, paneKey } = notice
    if (notice.desktop !== false) {
      try {
        getRuntimeDesktopSurface().showNotification({ title, body })
      } catch {
        // Headless runtimes still relay the notice to phones.
      }
    }
    if (notice.phone === false) {
      return
    }
    this.dispatch({
      type: 'notification',
      emittedAt: now,
      source: 'plugin',
      title,
      body,
      ...(worktreeId ? { worktreeId } : {}),
      ...(paneKey ? { paneKey } : {}),
      notificationId: id,
      attentionKey: id
    })
  }
}
