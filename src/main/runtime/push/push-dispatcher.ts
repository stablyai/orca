import { reserveNotificationCooldown } from '../../../shared/notification-burst-cooldown'
// Send background push after socket fan-out without making sockets wait or fail on gateway results.
import type { MobilePushRegistration } from '../../../shared/mobile-push-contract'
import { allowsMobilePushDelivery, mobilePushAlertContent } from '../../../shared/mobile-push-alert'
import type { MobileNotificationEvent } from '../runtime-mobile-notification-controller'
import type { PushGatewayClient, PushSendNotification } from './push-gateway-client'
import { PushOutcomeCounters } from './push-outcome-counters'

const PUSH_RETRY_DELAY_MS = 2_000
// Split requests at the gateway's per-send limit so extra paired phones still receive notifications.
const MAX_REGISTRATIONS_PER_SEND = 20

export type PushDispatcherRegistry = {
  listDevices(): readonly { deviceId: string; pushRegistration?: MobilePushRegistration }[]
  setPushRegistration(deviceId: string, registration: MobilePushRegistration | null): boolean
}

type PushDispatcherOptions = {
  client: PushGatewayClient
  registry: PushDispatcherRegistry
  /** Test seam: lets a suite drive the single retry without real time. */
  scheduleRetry?: (run: () => void, delayMs: number) => void
}

type PushTarget = { deviceId: string; registration: MobilePushRegistration }

export class PushDispatcher {
  private readonly recentNotifications = new Map<string, number>()
  private readonly outcomes = new PushOutcomeCounters()
  private stopped = false
  private readonly client: PushGatewayClient
  private readonly registry: PushDispatcherRegistry
  private readonly scheduleRetry: (run: () => void, delayMs: number) => void

  constructor(options: PushDispatcherOptions) {
    this.client = options.client
    this.registry = options.registry
    this.scheduleRetry =
      options.scheduleRetry ??
      ((run, delayMs) => {
        // Why: a pending push retry must never hold the app open at quit.
        setTimeout(run, delayMs).unref?.()
      })
  }

  start(): void {
    this.stopped = false
  }

  stop(): void {
    this.stopped = true
    this.outcomes.flush()
  }

  enqueue(event: MobileNotificationEvent): void {
    if (this.stopped) {
      return
    }
    try {
      const plan = this.planSend(event)
      if (!plan) {
        return
      }
      for (const sound of [true, false]) {
        const targets = plan.targets.filter(
          (target) => (target.registration.filter.sound !== false) === sound
        )
        for (let start = 0; start < targets.length; start += MAX_REGISTRATIONS_PER_SEND) {
          void this.deliver(
            targets.slice(start, start + MAX_REGISTRATIONS_PER_SEND),
            { ...plan.notification, ...(!sound ? { sound: false } : {}) },
            0
          )
        }
      }
    } catch (error) {
      console.warn('[push] Failed to prepare a push notification:', error)
    }
  }

  private planSend(
    event: MobileNotificationEvent
  ): { targets: PushTarget[]; notification: PushSendNotification } | null {
    if (event.type === 'dismiss') {
      const target = event.dismissedDelivery ?? event
      if (target.notificationSeq === undefined || !target.notificationEpoch) {
        return null
      }
      const targets = this.registry
        .listDevices()
        .flatMap(({ deviceId, pushRegistration: registration }) =>
          registration && registration.expiresAt > Date.now() ? [{ deviceId, registration }] : []
        )
      return {
        targets,
        notification: {
          kind: 'dismiss',
          expiresAt: Date.now() + 300_000,
          notificationId: target.notificationId,
          notificationSeq: target.notificationSeq,
          notificationEpoch: target.notificationEpoch,
          source: 'agent-task-complete',
          agentState: null,
          title: 'Orca',
          body: '',
          sound: false
        }
      }
    }
    const content = mobilePushAlertContent(event)
    if (!content) {
      return null
    }
    const targets = this.registry.listDevices().flatMap((device) => {
      const registration = device.pushRegistration
      if (
        !registration ||
        registration.expiresAt <= Date.now() ||
        !allowsMobilePushDelivery(registration.filter, event)
      ) {
        return []
      }
      if (
        event.emittedAt !== undefined &&
        !reserveNotificationCooldown(
          this.recentNotifications,
          // Keyed news is announced once by its producer, so only its own repeat may collapse it.
          JSON.stringify([device.deviceId, event.attentionKey ?? event.worktreeId ?? 'global']),
          event.emittedAt
        )
      ) {
        return []
      }
      return [{ deviceId: device.deviceId, registration }]
    })
    if (targets.length === 0) {
      return null
    }
    return {
      targets,
      notification: {
        expiresAt: Date.now() + 300_000,
        ...(event.notificationId ? { notificationId: event.notificationId } : {}),
        ...content,
        ...(event.worktreeId ? { worktreeId: event.worktreeId } : {}),
        ...(event.paneKey ? { paneKey: event.paneKey } : {}),
        ...(event.executionHost ? { executionHost: event.executionHost } : {})
      }
    }
  }

  private async deliver(
    targets: readonly PushTarget[],
    notification: PushSendNotification,
    attempt: number
  ): Promise<void> {
    if (this.stopped) {
      return
    }
    const currentTargets = targets.filter((target) =>
      this.registry
        .listDevices()
        .some(
          (device) =>
            device.deviceId === target.deviceId &&
            device.pushRegistration === target.registration &&
            target.registration.expiresAt > Date.now()
        )
    )
    if (!currentTargets.length) {
      return
    }
    try {
      const result = await this.client.send({
        registrationIds: currentTargets.map((target) => target.registration.registrationId),
        notification
      })
      if (this.stopped) {
        return
      }
      if (result.ok) {
        for (const entry of result.results) {
          if (entry.status === 'error' || entry.status === 'rate_limited') {
            this.outcomes.record(entry.status)
          }
        }
        this.dropDeadRegistrations(targets, result.results)
        return
      }
      this.outcomes.record(result.reason)
      // Retry transport misses once; an identical refused payload will be refused again.
      if (attempt === 0 && result.reason === 'unreachable') {
        this.scheduleRetry(() => {
          void this.deliver(targets, notification, attempt + 1)
        }, PUSH_RETRY_DELAY_MS)
      }
    } catch (error) {
      console.warn('[push] Push send failed:', error)
    }
  }

  private dropDeadRegistrations(
    targets: readonly PushTarget[],
    results: readonly { registrationId: string; status: string }[]
  ): void {
    for (const result of results) {
      if (result.status !== 'dead') {
        continue
      }
      const target = targets.find(
        (entry) => entry.registration.registrationId === result.registrationId
      )
      if (
        !target ||
        this.registry.listDevices().find((device) => device.deviceId === target.deviceId)
          ?.pushRegistration !== target.registration
      ) {
        continue
      }
      try {
        this.registry.setPushRegistration(target.deviceId, null)
      } catch (error) {
        console.warn('[push] Failed to drop a dead push registration:', error)
      }
    }
  }
}
