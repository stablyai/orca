import { randomUUID } from 'node:crypto'
import { resolveTelemetryDisableEnv } from '../../telemetry/consent'
import type { LegacyJournalRetirementReporter } from './journal-legacy-retirement-outcome'

type Subscriber = {
  connectionId: string
  deviceId: string
  subscriptionId: string
}

type ClaimRequest = Subscriber & { token: string }
type PendingDelivery = NonNullable<ReturnType<LegacyJournalRetirementReporter['pendingDelivery']>>

class LegacyJournalRetirementForwarding {
  private reporter: LegacyJournalRetirementReporter | undefined
  private readonly subscribers = new Map<string, Subscriber & { announce: () => void }>()
  private claimInFlight: {
    subscriber: Subscriber
    token: string
    deliveryId: string
    delivery: PendingDelivery
  } | null = null

  observe(reporter: LegacyJournalRetirementReporter, previous: PendingDelivery | null): void {
    const delivery = reporter.pendingDelivery()
    if (this.reporter === reporter && previous === delivery) {
      return
    }
    this.reporter = reporter
    this.claimInFlight = null
    if (delivery && !resolveTelemetryDisableEnv()) {
      for (const { announce } of this.subscribers.values()) {
        try {
          announce()
        } catch {
          // A failed write to one subscriber cannot fail cleanup or suppress the others.
        }
      }
    }
  }

  get available(): boolean {
    return this.reporter?.pendingDelivery() != null && !resolveTelemetryDisableEnv()
  }

  subscribe(subscriber: Subscriber, announce: () => void): () => void {
    this.subscribers.set(subscriber.subscriptionId, { ...subscriber, announce })
    return () => {
      this.subscribers.delete(subscriber.subscriptionId)
      if (this.claimInFlight?.subscriber.subscriptionId === subscriber.subscriptionId) {
        this.claimInFlight = null
      }
    }
  }

  claim(request: ClaimRequest) {
    const subscriber = this.authorizedSubscriber(request)
    const delivery = this.reporter?.pendingDelivery()
    if (!subscriber || !delivery?.version || this.claimInFlight || resolveTelemetryDisableEnv()) {
      return null
    }
    const deliveryId = randomUUID()
    this.claimInFlight = { subscriber, token: request.token, deliveryId, delivery }
    return { event: delivery.event, hostAppVersion: delivery.version, deliveryId }
  }

  async acknowledge(request: ClaimRequest, deliveryId: string | null): Promise<boolean> {
    const claim = this.claimInFlight
    if (
      !claim ||
      claim.token !== request.token ||
      claim.subscriber !== this.authorizedSubscriber(request) ||
      (deliveryId !== null && deliveryId !== claim.deliveryId)
    ) {
      return false
    }
    this.claimInFlight = null
    if (deliveryId === null || resolveTelemetryDisableEnv()) {
      return false
    }
    return (await this.reporter?.acceptPending(claim.delivery)) === true
  }

  private authorizedSubscriber(request: Subscriber): Subscriber | undefined {
    const subscriber = this.subscribers.get(request.subscriptionId)
    return subscriber?.connectionId === request.connectionId &&
      subscriber.deviceId === request.deviceId
      ? subscriber
      : undefined
  }
}

let orcadRuntime: object | undefined
let forwarding: LegacyJournalRetirementForwarding | undefined

export function enableLegacyJournalRetirementForwarding(runtime: object): () => void {
  orcadRuntime = runtime
  return () => {
    if (orcadRuntime === runtime) {
      orcadRuntime = undefined
      forwarding = undefined
    }
  }
}

export function legacyJournalRetirementForwarding(
  runtime: object
): LegacyJournalRetirementForwarding | undefined {
  if (runtime === orcadRuntime) {
    return (forwarding ??= new LegacyJournalRetirementForwarding())
  }
  return undefined
}

export function publishLegacyJournalRetirementPending(
  reporter: LegacyJournalRetirementReporter,
  previous: PendingDelivery | null
): void {
  if (orcadRuntime) {
    forwarding ??= new LegacyJournalRetirementForwarding()
    forwarding.observe(reporter, previous)
  }
}
