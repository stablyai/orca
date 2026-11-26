// Send background push after socket fan-out without making sockets wait or fail on gateway results.
import type { MobilePushRegistration } from '../../../shared/notifications/mobile-push-contract'
import {
  allowsMobilePushDelivery,
  mobilePushAlertContent
} from '../../../shared/notifications/mobile-push-alert'
import type { MobileNotificationEvent } from './notifications/runtime-mobile-notification-controller'
import {
  PushBurstSlots,
  pushBurstSubject,
  type ExecutionHostPushCoverage
} from './push-burst-slots'
import type { PushGatewayClient, PushSendNotification } from './push-gateway-client'
import { PushOutcomeCounters } from './push-outcome-counters'
import {
  NOTIFICATION_PUSH_COVERAGE_MAX_DIGESTS,
  type NotificationPushCoverageRequest
} from '../../../shared/rpc-contract/notifications/notifications-params'
import type { MobilePushDeliveryMode } from './mobile-push-delivery-policy'

const PUSH_RETRY_DELAY_MS = 2_000
// Split requests at the gateway's per-send limit so extra paired phones still receive notifications.
export const MAX_REGISTRATIONS_PER_SEND = 20

export type PushDispatcherRegistry = {
  listDevices(): readonly { deviceId: string; pushRegistration?: MobilePushRegistration }[]
  setPushRegistration(deviceId: string, registration: MobilePushRegistration | null): boolean
}

type PushDispatcherOptions = {
  client: PushGatewayClient
  registry: PushDispatcherRegistry
  deliveryMode?: MobilePushDeliveryMode
  /** Test seam: lets a suite drive the single retry without real time. */
  scheduleRetry?: (run: () => void, delayMs: number) => void
  coverage?: ExecutionHostPushCoverage
}

export type PushCoverageRequest = NotificationPushCoverageRequest

const NO_COVERAGE: ReadonlySet<string> = new Set()
const NOTHING_QUEUED: ReadonlySet<string> = new Set()

type PushTarget = {
  deviceId: string
  registration: MobilePushRegistration
  /** The burst slot this push holds, so another host can learn whether it went out. */
  slot?: string
}

export class PushDispatcher {
  private readonly slots = new PushBurstSlots()
  private readonly outcomes = new PushOutcomeCounters()
  private stopped = false
  private readonly client: PushGatewayClient
  private readonly registry: PushDispatcherRegistry
  private readonly deliveryMode: MobilePushDeliveryMode
  private readonly scheduleRetry: (run: () => void, delayMs: number) => void
  private readonly coverage: ExecutionHostPushCoverage | undefined

  constructor(options: PushDispatcherOptions) {
    this.coverage = options.coverage
    this.client = options.client
    this.registry = options.registry
    this.deliveryMode = options.deliveryMode ?? 'full'
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
    if (this.stopped || this.deliveryMode === 'disabled') {
      return
    }
    const executionHost = event.type === 'notification' ? event.executionHost : undefined
    const tokenDigests = this.registry
      .listDevices()
      .flatMap(({ pushRegistration: registration }) =>
        executionHost &&
        registration?.tokenDigest &&
        registration.expiresAt > Date.now() &&
        allowsMobilePushDelivery(registration.filter, event)
          ? [registration.tokenDigest]
          : []
      )
    if (!this.coverage || event.type !== 'notification' || !executionHost || !tokenDigests.length) {
      this.send(event, NO_COVERAGE)
      return
    }
    // A mirrored session's own host may already have pushed the phones it has; this copy is for the rest.
    void this.coverage
      .ask(executionHost, {
        // Phones past the cap are not asked about, so they keep this desktop's copy.
        tokenDigests: tokenDigests.slice(0, NOTIFICATION_PUSH_COVERAGE_MAX_DIGESTS),
        subject: pushBurstSubject(event)
      })
      .catch((error: unknown) => {
        console.warn('[push] Could not ask the execution host which phones it pushes:', error)
        return NO_COVERAGE
      })
      .then((covered) => {
        if (!this.stopped) {
          this.send(event, covered)
        }
      })
  }

  /** Of these phones, the ones a push the gateway took already holds the subject's slot for. */
  async coveredTokenDigests(request: PushCoverageRequest): Promise<string[]> {
    return !this.stopped && this.deliveryMode !== 'disabled'
      ? this.slots.coveredDigests(this.registry.listDevices(), request, Date.now())
      : []
  }

  private send(event: MobileNotificationEvent, covered: ReadonlySet<string>): void {
    try {
      const plan = this.planSend(event, covered)
      if (!plan) {
        return
      }
      for (const sound of [true, false]) {
        const targets = plan.targets.filter(
          (target) => (target.registration.filter.sound !== false) === sound
        )
        for (let start = 0; start < targets.length; start += MAX_REGISTRATIONS_PER_SEND) {
          const batch = targets.slice(start, start + MAX_REGISTRATIONS_PER_SEND)
          const queued = this.deliver(
            batch,
            { ...plan.notification, ...(!sound ? { sound: false } : {}) },
            0
          )
          for (const { slot, registration } of batch) {
            if (slot) {
              this.slots.recordDelivery(
                slot,
                queued.then((ids) =>
                  ids.has(registration.registrationId) ? registration.tokenDigest : undefined
                )
              )
            }
          }
        }
      }
    } catch (error) {
      console.warn('[push] Failed to prepare a push notification:', error)
    }
  }

  private planSend(
    event: MobileNotificationEvent,
    covered: ReadonlySet<string>
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
        !allowsMobilePushDelivery(registration.filter, event) ||
        (registration.tokenDigest !== undefined && covered.has(registration.tokenDigest))
      ) {
        return []
      }
      if (event.emittedAt === undefined) {
        return [{ deviceId: device.deviceId, registration }]
      }
      const slot = this.slots.reserve(device.deviceId, pushBurstSubject(event), event.emittedAt)
      return slot ? [{ deviceId: device.deviceId, registration, slot }] : []
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
  ): Promise<ReadonlySet<string>> {
    if (this.stopped) {
      return NOTHING_QUEUED
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
      return NOTHING_QUEUED
    }
    try {
      const result = await this.client.send({
        registrationIds: currentTargets.map((target) => target.registration.registrationId),
        notification
      })
      if (this.stopped) {
        return NOTHING_QUEUED
      }
      if (result.ok) {
        for (const entry of result.results) {
          if (entry.status === 'error' || entry.status === 'rate_limited') {
            this.outcomes.record(entry.status)
          }
        }
        dropDeadPushRegistrations(this.registry, targets, result.results)
        return new Set(
          result.results.flatMap((entry) =>
            entry.status === 'queued' ? [entry.registrationId] : []
          )
        )
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
    return NOTHING_QUEUED
  }
}

/** Forgets registrations the gateway reports dead, unless the device re-registered since. */
export function dropDeadPushRegistrations(
  registry: PushDispatcherRegistry,
  targets: readonly { deviceId: string; registration: MobilePushRegistration }[],
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
      registry.listDevices().find((device) => device.deviceId === target.deviceId)
        ?.pushRegistration !== target.registration
    ) {
      continue
    }
    try {
      registry.setPushRegistration(target.deviceId, null)
    } catch (error) {
      console.warn('[push] Failed to drop a dead push registration:', error)
    }
  }
}
