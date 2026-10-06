import { reserveNotificationCooldown } from '../../../shared/notification-burst-cooldown'
// Why: the out-of-band leg of the mobile notification fan-out. Every event that
// already went to connected sockets is offered to the push gateway so a phone
// with Orca closed still hears about it. Fire-and-forget by construction: the
// socket fan-out must never wait on, or fail because of, a push.
import {
  MOBILE_PUSH_SOURCES,
  type MobilePushAgentState,
  type MobilePushRegistration
} from '../../../shared/mobile-push-contract'
import type { MobileNotificationEvent } from '../runtime-mobile-notification-controller'
import type { PushGatewayClient, PushSendNotification } from './push-gateway-client'
import { PushOutcomeCounters } from './push-outcome-counters'

const PUSH_RETRY_DELAY_MS = 2_000
// The gateway rejects a whole request above this, so a host with more paired
// phones fans out across several sends rather than starving the extras.
const MAX_REGISTRATIONS_PER_SEND = 20
const PUSH_TITLE_MAX_LENGTH = 80
const PUSH_BODY_MAX_LENGTH = 180

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

function clip(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`
}

export function mapPushAgentState(
  source: string,
  state: string | undefined
): MobilePushAgentState | null | undefined {
  if (source !== 'agent-task-complete') {
    return null
  }
  if (state === 'blocked' || state === 'waiting' || state === 'needs-input') {
    return 'needs-input'
  }
  return state === undefined || state === 'done' || state === 'finished' ? 'finished' : undefined
}

function allowsPushDelivery(
  registration: MobilePushRegistration,
  event: MobileNotificationEvent
): boolean {
  return (
    event.type === 'notification' &&
    event.desktopAllowed !== false &&
    (!registration.filter.onlyWhenDesktopAway || event.desktopAway !== false)
  )
}

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
      if (event.notificationSeq === undefined || !event.notificationEpoch) {
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
          notificationId: event.notificationId,
          notificationSeq: event.notificationSeq,
          notificationEpoch: event.notificationEpoch,
          source: 'agent-task-complete',
          agentState: null,
          title: 'Orca',
          body: '',
          sound: false
        }
      }
    }
    const source = MOBILE_PUSH_SOURCES.find((candidate) => candidate === event.source)
    if (!source || event.notificationSeq === undefined || event.notificationEpoch === undefined) {
      return null
    }
    const agentState = mapPushAgentState(source, event.agentState)
    if (agentState === undefined) {
      return null
    }
    const targets = this.registry.listDevices().flatMap((device) => {
      const registration = device.pushRegistration
      if (
        !registration ||
        registration.expiresAt <= Date.now() ||
        !allowsPushDelivery(registration, event)
      ) {
        return []
      }
      if (
        event.emittedAt !== undefined &&
        !reserveNotificationCooldown(
          this.recentNotifications,
          JSON.stringify([device.deviceId, event.worktreeId ?? 'global']),
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
        notificationSeq: event.notificationSeq,
        notificationEpoch: event.notificationEpoch,
        source,
        agentState,
        title: clip(event.title, PUSH_TITLE_MAX_LENGTH),
        body: clip(event.body, PUSH_BODY_MAX_LENGTH),
        ...(event.worktreeId ? { worktreeId: event.worktreeId } : {})
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
      // Only a transport-level miss is worth repeating; a gateway that refused
      // this payload will refuse the identical retry.
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
