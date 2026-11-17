// Send background push after socket fan-out without making sockets wait or fail on gateway results.
import type { MobilePushRegistration } from '../../../shared/notifications/mobile-push-contract'
import {
  allowsMobilePushDelivery,
  mobilePushAlertContent
} from '../../../shared/notifications/mobile-push-alert'
import type { MobileNotificationEvent } from './notifications/runtime-mobile-notification-controller'
import { PushBurstSlots, pushBurstSubject } from './push-burst-slots'
import type { PushGatewayClient, PushSendNotification } from './push-gateway-client'
import { PushOutcomeCounters } from './push-outcome-counters'
import {
  NOTIFICATION_PUSH_COVERAGE_MAX_DIGESTS,
  type NotificationPushCoverageRequest
} from '../../../shared/rpc-contract/notifications/notifications-params'
import type { MobilePushDeliveryMode } from './mobile-push-delivery-policy'

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
  deliveryMode?: MobilePushDeliveryMode
  /** Test seam: lets a suite drive the single retry without real time. */
  scheduleRetry?: (run: () => void, delayMs: number) => void
  resolveCoverage?: PushCoverageResolver
}

export type PushCoverageRequest = NotificationPushCoverageRequest

/** Token digests of phones the alert's execution host pushes itself; empty when it pushes none. */
export type PushCoverageResolver = (
  executionHost: string,
  request: PushCoverageRequest
) => Promise<ReadonlySet<string>>

const NO_COVERAGE: ReadonlySet<string> = new Set()
const NOTHING_QUEUED: ReadonlySet<string> = new Set()

type PushTarget = {
  deviceId: string
  registration: MobilePushRegistration
  /** The burst slot this push holds, so a mirroring host can learn whether it went out. */
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
  private readonly resolveCoverage: PushCoverageResolver | undefined

  constructor(options: PushDispatcherOptions) {
    this.resolveCoverage = options.resolveCoverage
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
    try {
      const plan = this.planSend(event)
      if (!plan) {
        return
      }
      const asked = plan.targets.flatMap((target) => target.registration.tokenDigest ?? [])
      if (
        !this.resolveCoverage ||
        event.type !== 'notification' ||
        !event.executionHost ||
        asked.length === 0
      ) {
        this.deliverPlan(plan.targets, plan.notification)
        return
      }
      // A mirrored session's own host already pushes the phones it has; this copy is for the rest.
      void this.resolveCoverage(event.executionHost, {
        // Phones past the cap are not asked about, so they keep this desktop's copy.
        tokenDigests: asked.slice(0, NOTIFICATION_PUSH_COVERAGE_MAX_DIGESTS),
        subject: pushBurstSubject(event)
      })
        .catch((error: unknown) => {
          console.warn('[push] Could not ask the execution host which phones it pushes:', error)
          return NO_COVERAGE
        })
        .then((covered) =>
          this.deliverPlan(
            plan.targets.filter(
              (target) =>
                target.registration.tokenDigest === undefined ||
                !covered.has(target.registration.tokenDigest)
            ),
            plan.notification
          )
        )
    } catch (error) {
      console.warn('[push] Failed to prepare a push notification:', error)
    }
  }

  /** Of these phones, the ones this host pushed for the subject; it leaves the rest to the mirror. */
  async coveredTokenDigests(request: PushCoverageRequest): Promise<string[]> {
    if (this.stopped || this.deliveryMode === 'disabled') {
      return []
    }
    const asked = new Set(request.tokenDigests)
    const now = Date.now()
    const answers = this.registry.listDevices().map(async ({ deviceId, pushRegistration }) => {
      const digest = pushRegistration?.tokenDigest
      return digest &&
        asked.has(digest) &&
        (await this.slots.coveredForMirror(deviceId, request.subject, now))
        ? [digest]
        : []
    })
    return (await Promise.all(answers)).flat()
  }

  private deliverPlan(targets: readonly PushTarget[], notification: PushSendNotification): void {
    if (this.stopped) {
      return
    }
    for (const sound of [true, false]) {
      const withSound = targets.filter(
        (target) => (target.registration.filter.sound !== false) === sound
      )
      for (let start = 0; start < withSound.length; start += MAX_REGISTRATIONS_PER_SEND) {
        const batch = withSound.slice(start, start + MAX_REGISTRATIONS_PER_SEND)
        const queued = this.deliver(
          batch,
          { ...notification, ...(!sound ? { sound: false } : {}) },
          0
        )
        for (const target of batch) {
          if (target.slot) {
            this.slots.recordDelivery(
              target.slot,
              queued.then((ids) => ids.has(target.registration.registrationId))
            )
          }
        }
      }
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
        this.dropDeadRegistrations(targets, result.results)
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
