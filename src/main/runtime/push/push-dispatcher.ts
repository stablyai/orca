// Why: the out-of-band leg of the mobile notification fan-out. Every event that
// already went to connected sockets is offered to the push gateway so a phone
// with Orca closed still hears about it. Fire-and-forget by construction: the
// socket fan-out must never wait on, or fail because of, a push.
import type {
  MobilePushAgentState,
  MobilePushRegistration
} from '../../../shared/mobile-push-contract'
import { MOBILE_PUSH_SOURCES } from '../../../shared/mobile-push-contract'
import type { MobileNotificationEvent } from '../runtime-mobile-notification-controller'
import type { PushGatewayClient, PushSendNotification } from './push-gateway-client'

const PUSH_RETRY_DELAY_MS = 2_000
// The gateway rejects a whole request above this; a host with more paired phones
// than this still pushes to the first 20 rather than to none.
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

type PushTarget = { deviceId: string; registrationId: string }

function clip(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`
}

/**
 * Maps desktop agent status onto the two states a phone understands.
 * `null` means "this event has no agent state" (a bell or a plugin alert), and
 * `undefined` means "do not push" — an agent that is still working has not
 * produced anything the user needs to be woken for.
 */
export function mapPushAgentState(
  source: string,
  agentState: string | undefined
): MobilePushAgentState | null | undefined {
  if (source !== 'agent-task-complete') {
    return null
  }
  if (agentState === 'blocked' || agentState === 'waiting') {
    return 'needs-input'
  }
  // Absent state means the hook snapshot was gone by dispatch time; the
  // notification itself only fires on completion, so it stays a finish.
  return agentState === undefined || agentState === 'done' ? 'finished' : undefined
}

export class PushDispatcher {
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

  enqueue(event: MobileNotificationEvent): void {
    try {
      const plan = this.planSend(event)
      if (plan) {
        void this.deliver(plan.targets, plan.notification, 0)
      }
    } catch (error) {
      console.warn('[push] Failed to prepare a push notification:', error)
    }
  }

  private planSend(
    event: MobileNotificationEvent
  ): { targets: PushTarget[]; notification: PushSendNotification } | null {
    // Dismissals are a socket-only concern; the phone clears its own banner.
    if (event.type !== 'notification') {
      return null
    }
    const source = MOBILE_PUSH_SOURCES.find((candidate) => candidate === event.source)
    if (!source || event.notificationSeq === undefined || event.notificationEpoch === undefined) {
      return null
    }
    const agentState = mapPushAgentState(source, event.agentState)
    if (agentState === undefined) {
      return null
    }
    const targets = this.registry
      .listDevices()
      .flatMap((device) => {
        const registration = device.pushRegistration
        if (!registration || !registration.filter.sources.includes(source)) {
          return []
        }
        if (agentState !== null && !registration.filter.agentStates.includes(agentState)) {
          return []
        }
        return [{ deviceId: device.deviceId, registrationId: registration.registrationId }]
      })
      .slice(0, MAX_REGISTRATIONS_PER_SEND)
    if (targets.length === 0) {
      return null
    }
    return {
      targets,
      notification: {
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
    try {
      const result = await this.client.send({
        registrationIds: targets.map((target) => target.registrationId),
        notification
      })
      if (result.ok) {
        this.dropDeadRegistrations(targets, result.results)
        return
      }
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
      const target = targets.find((entry) => entry.registrationId === result.registrationId)
      if (!target) {
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
