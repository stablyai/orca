import { subscribeHostSession } from './mobile-web-session-host-subscription'
import { subscribeMobileWebHostWorkspace } from './mobile-web-host-workspace-subscription'
import {
  hostSubscriptionSetup,
  isMobileWebHostSubscriptionEnd
} from './mobile-web-host-subscription-setup'
import type {
  MobileWebBridgeCapability,
  MobileWebBridgePageMessage,
  MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import type {
  MobileWebSessionSnapshotResult,
  MobileWebSessionSubscribePayload,
  MobileWebWorkspaceChange
} from '../../shared/mobile-web/bridge-operation-contract'
import type {
  MobileWebTerminalEvent,
  MobileWebTerminalRequest
} from '../../shared/mobile-web/terminal-stream-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { deliverMobileWebSubscriptionEvent } from './mobile-web-bridge-subscription-event-delivery'
import {
  terminalSubscriptionSetup,
  speechSubscriptionSetup,
  type MobileWebBridgeSubscriptionSetup
} from './mobile-web-bridge-subscription-setup'
import { mobileWebSubscriptionSetupError } from './mobile-web-subscription-setup-error'
import type {
  MobileWebBridgeSubscription,
  MobileWebTerminalBridgeSubscription
} from './mobile-web-bridge-subscription'
import type {
  MobileWebActiveSubscription,
  MobileWebPendingSubscription
} from './mobile-web-bridge-subscription-state'

export type {
  MobileWebBridgeSubscription,
  MobileWebTerminalBridgeSubscription
} from './mobile-web-bridge-subscription'

type OperationGrant = Extract<MobileWebBridgeShellMessage, { type: 'init' }>['grants'][number]

const REQUEST_TIMEOUT_MS = 15_000

export class MobileWebBridgeSubscriptionClient {
  private readonly pending = new Map<string, MobileWebPendingSubscription>()
  private readonly active = new Map<string, MobileWebActiveSubscription>()
  private disposed = false

  constructor(
    private readonly options: {
      getGrant: (
        capability: MobileWebBridgeCapability,
        operation?: string
      ) => OperationGrant | undefined
      postMessage: (message: MobileWebBridgePageMessage) => boolean
      envelope: () => Pick<MobileWebBridgePageMessage, 'version' | 'shellSessionId' | 'buildId'>
      createMessageId: (excluded?: string) => string
      otherPendingCount: () => number
      requestTimeoutMs?: number
    }
  ) {}

  subscribe(
    payload: MobileWebSessionSubscribePayload,
    onEvent: (snapshot: MobileWebSessionSnapshotResult) => void,
    onError: (error: MobileWebBridgeClientError) => void
  ): MobileWebBridgeSubscription {
    return subscribeHostSession(this, payload, onEvent, onError)
  }

  subscribeWorkspace(
    onEvent: (event: MobileWebWorkspaceChange) => void,
    onError: (error: MobileWebBridgeClientError) => void
  ): MobileWebBridgeSubscription {
    return subscribeMobileWebHostWorkspace(this, onEvent, onError)
  }

  subscribeTerminal(
    payload: Extract<MobileWebTerminalRequest, { operation: 'subscribe' }>,
    onEvent: (event: MobileWebTerminalEvent) => void,
    onError: (error: MobileWebBridgeClientError) => void
  ): MobileWebTerminalBridgeSubscription {
    const subscription = this.subscribeWith(terminalSubscriptionSetup(payload, onEvent, onError))
    return { ...subscription, streamId: subscription.subscriptionId }
  }

  subscribeHost(...args: Parameters<typeof hostSubscriptionSetup>) {
    return this.subscribeWith(hostSubscriptionSetup(...args))
  }

  subscribeSpeech(...args: Parameters<typeof speechSubscriptionSetup>) {
    return this.subscribeWith(speechSubscriptionSetup(...args))
  }

  private subscribeWith(
    setup: MobileWebBridgeSubscriptionSetup
  ): MobileWebBridgeSubscription & { subscriptionId: string } {
    const grant = this.options.getGrant(setup.capability, setup.operation ?? 'subscribe')
    const parsedPayload = setup.payloadSchema.safeParse(setup.payload)
    const error = mobileWebSubscriptionSetupError({
      disposed: this.disposed,
      grant,
      payloadValid: parsedPayload.success,
      payload: parsedPayload.data,
      pendingCount: this.pending.size,
      otherPendingCount: this.options.otherPendingCount(),
      activeCount: this.active.size
    })
    if (error) {
      queueMicrotask(() => setup.onError(error))
      return { ready: Promise.reject(error), unsubscribe: () => {}, subscriptionId: '' }
    }

    let requestId: string
    let subscriptionId: string
    try {
      requestId = this.options.createMessageId()
      subscriptionId = this.options.createMessageId(requestId)
    } catch (cause) {
      const idError =
        cause instanceof MobileWebBridgeClientError
          ? cause
          : new MobileWebBridgeClientError('internal', false)
      queueMicrotask(() => setup.onError(idError))
      return { ready: Promise.reject(idError), unsubscribe: () => {}, subscriptionId: '' }
    }

    let resolveReady = (): void => {}
    let rejectReady = (_error: MobileWebBridgeClientError): void => {}
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const subscription: MobileWebActiveSubscription = {
      requestId,
      nextSequence: 0,
      eventSchema: setup.eventSchema,
      onEvent: (event) => {
        try {
          setup.onEvent(event)
        } finally {
          // The shell retires host streams after their terminal frame, even if the screen stays mounted.
          if (setup.operation === 'hostSubscribe' && isMobileWebHostSubscriptionEnd(event)) {
            this.unsubscribe(subscriptionId, subscription)
          }
        }
      },
      onError: setup.onError
    }
    this.active.set(subscriptionId, subscription)
    const timer = setTimeout(
      () => this.fail(subscriptionId, new MobileWebBridgeClientError('timeout', true), true),
      this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    )
    this.pending.set(requestId, {
      subscriptionId,
      resolve: resolveReady,
      reject: rejectReady,
      timer
    })
    const posted = this.options.postMessage({
      ...this.options.envelope(),
      type: 'request',
      mode: 'subscription',
      requestId,
      subscriptionId,
      capability: setup.capability,
      operation: setup.operation ?? 'subscribe',
      payload: parsedPayload.data
    })
    if (!posted) {
      this.fail(subscriptionId, new MobileWebBridgeClientError('unavailable', true))
    }
    return {
      ready,
      subscriptionId,
      unsubscribe: () => this.unsubscribe(subscriptionId, subscription)
    }
  }

  receive(message: MobileWebBridgeShellMessage): boolean {
    if (this.disposed) {
      return false
    }
    if (message.type === 'event') {
      return this.receiveEvent(message)
    }
    if (message.type === 'subscriptionClosed') {
      // fail() no-ops on an unknown id, and no request path handles this frame, so it stops here.
      this.fail(
        message.subscriptionId,
        new MobileWebBridgeClientError(message.error.code, message.error.retryable),
        true
      )
      return true
    }
    if (message.type !== 'response') {
      return false
    }
    const pending = this.pending.get(message.requestId)
    if (!pending) {
      return false
    }
    if (message.status === 'success' && message.payload !== null) {
      this.fail(pending.subscriptionId, new MobileWebBridgeClientError('invalid_message', false))
      return true
    }
    clearTimeout(pending.timer)
    this.pending.delete(message.requestId)
    if (message.status === 'error') {
      const error = new MobileWebBridgeClientError(message.error.code, message.error.retryable)
      const subscription = this.active.get(pending.subscriptionId)
      this.active.delete(pending.subscriptionId)
      pending.reject(error)
      subscription?.onError(error)
      return true
    }
    pending.resolve()
    return true
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const subscriptionId of this.active.keys()) {
      this.postCancel('subscription', subscriptionId)
    }
    this.active.clear()
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.postCancel('request', requestId)
      pending.reject(new MobileWebBridgeClientError('cancelled', false))
    }
    this.pending.clear()
  }

  hasMessageId(id: string): boolean {
    return this.pending.has(id) || this.active.has(id)
  }

  pendingCount(): number {
    return this.pending.size
  }

  private receiveEvent(message: Extract<MobileWebBridgeShellMessage, { type: 'event' }>): boolean {
    const subscription = this.active.get(message.subscriptionId)
    if (!subscription) {
      return false
    }
    deliverMobileWebSubscriptionEvent(subscription, message, (error) =>
      this.fail(message.subscriptionId, error)
    )
    return true
  }

  private unsubscribe(subscriptionId: string, expected: MobileWebActiveSubscription): void {
    if (this.active.get(subscriptionId) !== expected) {
      return
    }
    this.active.delete(subscriptionId)
    this.postCancel('subscription', subscriptionId)
    const pending = this.pending.get(expected.requestId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pending.delete(expected.requestId)
      pending.reject(new MobileWebBridgeClientError('cancelled', false))
    }
  }

  private fail(
    subscriptionId: string,
    error: MobileWebBridgeClientError,
    cancelRequest = false
  ): void {
    const subscription = this.active.get(subscriptionId)
    if (!subscription) {
      return
    }
    this.active.delete(subscriptionId)
    this.postCancel('subscription', subscriptionId)
    const pending = this.pending.get(subscription.requestId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pending.delete(subscription.requestId)
      if (cancelRequest) {
        this.postCancel('request', subscription.requestId)
      }
      pending.reject(error)
    }
    subscription.onError(error)
  }

  private postCancel(target: 'request' | 'subscription', id: string): void {
    this.options.postMessage({
      ...this.options.envelope(),
      type: 'cancel',
      target,
      id
    })
  }
}
