import { requireMobileWebConnectedClient } from './mobile-web-connected-client'
import type {
  MobileWebBridgePageMessage,
  MobileWebConnectionState,
  MobileWebResumeRoute
} from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import {
  isRetryableMobileWebBridgeError,
  MobileWebBrokerError,
  mobileWebBridgeErrorCode
} from './mobile-web-broker-error'
import { MobileWebOperationRateLimiter } from './mobile-web-operation-rate-limiter'
import { MobileWebCommitMessageGeneration } from './mobile-web-commit-message-generation'
import { MobileWebHostSubscriptions } from './mobile-web-host-subscriptions'
import { MOBILE_WEB_PRODUCTION_GRANT_INDEX } from './mobile-web-production-grants'
import { MobileWebTerminalStreams } from './mobile-web-terminal-streams'
import { MOBILE_WEB_TERMINAL_CLIENT_CLOSURE } from './mobile-web-terminal-stream-retirement'
import { MobileWebSpeechAuthority } from './mobile-web-speech-authority'
import { executeMobileWebCapabilityRequest } from './mobile-web-capability-execution'
import { MobileWebCapabilityAuthorities } from './mobile-web-capability-authorities'
import type { MobileWebCapabilityBrokerOptions } from './mobile-web-capability-broker-options'
import { MobileWebBrokerMessageSender } from './mobile-web-broker-message-sender'
import { MobileWebBrokerReplayWindow } from './mobile-web-broker-replay-window'
import { rememberMobileWebBrokerRoute } from './mobile-web-broker-route-memory'
import { resolveMobileWebHostNavigationRoute } from './mobile-web-host-navigation-route'
import {
  mobileWebEncodedByteLength,
  mobileWebIsHostRequest,
  mobileWebRequestAtCapacity,
  mobileWebRequestSurvivesCancellation,
  mobileWebOperationKey,
  mobileWebPendingRequestForSubscription,
  mobileWebRequestExpectsSubscription,
  mobileWebWorkspaceSnapshotContinuation
} from './mobile-web-request-accounting'

type PageRequest = Extract<MobileWebBridgePageMessage, { type: 'request' }>
type PendingRequest = { operationKey: string; subscriptionId?: string; cancelled: boolean }

export class MobileWebCapabilityBroker {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly replay = new MobileWebBrokerReplayWindow()
  private readonly subscriptions: MobileWebHostSubscriptions
  private readonly terminalStreams: MobileWebTerminalStreams
  private readonly speechAuthority: MobileWebSpeechAuthority
  private readonly rateLimiter: MobileWebOperationRateLimiter
  private readonly commitMessageGeneration = new MobileWebCommitMessageGeneration()
  private readonly authorities: MobileWebCapabilityAuthorities
  private readonly messages: MobileWebBrokerMessageSender
  private hostRequestsInFlight = 0
  private disposed = false
  private clientEpoch = 0

  constructor(private readonly options: MobileWebCapabilityBrokerOptions) {
    this.rateLimiter = new MobileWebOperationRateLimiter(options.now ?? Date.now)
    this.authorities = new MobileWebCapabilityAuthorities(options)
    this.messages = new MobileWebBrokerMessageSender({
      context: options.context,
      isActive: () => !this.disposed && options.isActive(),
      postMessage: options.postMessage
    })
    const posts = this.messages.subscriptionPosts()
    this.subscriptions = new MobileWebHostSubscriptions({
      ...posts,
      workspaceAuthority: this.authorities.workspace
    })
    this.terminalStreams = new MobileWebTerminalStreams({
      ...posts,
      clientId: options.terminalClientId,
      now: options.now,
      onFlowMetrics: options.onTerminalFlowMetrics,
      onResync: options.onTerminalResync,
      workspaceAuthority: this.authorities.workspace
    })
    this.speechAuthority = new MobileWebSpeechAuthority(posts)
  }

  async handle(message: MobileWebBridgePageMessage): Promise<void> {
    if (this.disposed || !this.options.isActive()) {
      return
    }
    if (message.type === 'cancel') {
      await this.cancel(message.target, message.id)
    } else if (message.type === 'request') {
      await this.handleRequest(message)
    }
  }

  dispose(): void {
    this.disposed = true
    this.clientEpoch += 1
    this.commitMessageGeneration.dispose()
    this.subscriptions.dispose()
    this.terminalStreams.dispose(this.options.getClient())
    this.speechAuthority.dispose()
    this.authorities.clear()
    this.pending.clear()
    this.replay.clear()
    this.rateLimiter.clear()
  }

  replaceClient(client: RpcClient | null): void {
    this.clientEpoch += 1
    this.authorities.clear()
    this.commitMessageGeneration.replaceClient(client)
    // The page document outlives the swap, so every live subscription needs a terminal frame; a
    // silent teardown leaves it waiting on a feed the new client will never resume.
    this.subscriptions.closeAll({ code: 'unavailable', retryable: true })
    this.terminalStreams.dispose(null, MOBILE_WEB_TERMINAL_CLIENT_CLOSURE)
    this.speechAuthority.replaceClient()
    for (const [requestId, pending] of this.pending) {
      if (mobileWebRequestSurvivesCancellation(pending)) {
        continue
      }
      pending.cancelled = true
      this.pending.delete(requestId)
      void this.messages.error(requestId, 'cancelled', false)
    }
  }
  updateConnectionState(state: MobileWebConnectionState): void {
    if (state !== 'connected') {
      void this.speechAuthority.cancel('disconnected')
    }
  }
  updateAppForegroundState(foreground: boolean): void {
    if (!foreground) {
      this.speechAuthority.cancelForAppBackground()
    }
  }
  rememberRoute(route: MobileWebResumeRoute, pageState?: string): void {
    rememberMobileWebBrokerRoute(
      !this.disposed && this.options.isActive(),
      route,
      this.authorities.workspace,
      this.options,
      pageState
    )
  }
  async resolveNavigationRoute(hostWorkspaceId: string): Promise<MobileWebResumeRoute> {
    if (this.disposed || !this.options.isActive()) {
      throw new MobileWebBrokerError('cancelled')
    }
    const epoch = this.clientEpoch
    return resolveMobileWebHostNavigationRoute(
      hostWorkspaceId,
      requireMobileWebConnectedClient(this.options),
      this.authorities.workspace,
      () => epoch === this.clientEpoch && !this.disposed && this.options.isActive()
    )
  }
  private async handleRequest(request: PageRequest): Promise<void> {
    if (this.pending.has(request.requestId) || !this.replay.accept(request.requestId)) {
      await this.messages.error(request.requestId, 'invalid_request', false)
      return
    }

    const isHostRequest = mobileWebIsHostRequest(request)
    const isHostForward =
      isHostRequest || (request.capability === 'workspace' && request.operation === 'hostSubscribe')
    const grant = MOBILE_WEB_PRODUCTION_GRANT_INDEX.get(mobileWebOperationKey(request))
    const expectsSubscription = mobileWebRequestExpectsSubscription(request)
    if (!grant || (request.mode === 'subscription') !== expectsSubscription) {
      await this.messages.error(request.requestId, 'unsupported_capability', false)
      return
    }
    if (request.mode === 'subscription' && !this.replay.accept(request.subscriptionId)) {
      await this.messages.error(request.requestId, 'invalid_request', false)
      return
    }
    // Generic forwarding checks the envelope after rewriting the workspace handle.
    if (
      !isHostForward &&
      mobileWebEncodedByteLength(request.payload) > grant.limits.maxRequestBytes
    ) {
      await this.messages.error(request.requestId, 'too_large', false)
      return
    }
    if (
      mobileWebRequestAtCapacity({
        pending: this.pending,
        request,
        isHostRequest,
        hostRequestsInFlight: this.hostRequestsInFlight,
        ledgers: [this.subscriptions, this.terminalStreams, this.speechAuthority],
        maxConcurrent: grant.limits.maxConcurrent
      })
    ) {
      await this.messages.error(request.requestId, 'rate_limited', true)
      return
    }
    if (
      !mobileWebWorkspaceSnapshotContinuation(request) &&
      !this.rateLimiter.take(mobileWebOperationKey(request), grant)
    ) {
      await this.messages.error(request.requestId, 'rate_limited', true)
      return
    }

    const pending: PendingRequest = {
      operationKey: mobileWebOperationKey(request),
      ...(request.mode === 'subscription' ? { subscriptionId: request.subscriptionId } : {}),
      cancelled: false
    }
    this.pending.set(request.requestId, pending)
    if (isHostRequest) {
      this.hostRequestsInFlight += 1
    }
    try {
      const payload = await this.execute(request, () => this.isPending(request.requestId, pending))
      if (!this.isPending(request.requestId, pending)) {
        return
      }
      this.pending.delete(request.requestId)
      await (!isHostForward && mobileWebEncodedByteLength(payload) > grant.limits.maxResponseBytes
        ? this.messages.error(request.requestId, 'unavailable', false)
        : this.messages.success(request.requestId, payload))
    } catch (error) {
      this.subscriptions.cancelByRequest(request.requestId)
      this.terminalStreams.cancelByRequest(request.requestId, this.options.getClient())
      this.speechAuthority.cancelByRequest(request.requestId)
      if (this.isPending(request.requestId, pending)) {
        this.pending.delete(request.requestId)
        const code = mobileWebBridgeErrorCode(error)
        await this.messages.error(request.requestId, code, isRetryableMobileWebBridgeError(code))
      }
    } finally {
      // Cancellation retires the page request before the host releases its retained work.
      if (isHostRequest) {
        this.hostRequestsInFlight -= 1
      }
      if (this.pending.get(request.requestId) === pending) {
        this.pending.delete(request.requestId)
      }
    }
  }

  private async execute(request: PageRequest, isRequestActive: () => boolean): Promise<unknown> {
    return executeMobileWebCapabilityRequest({
      request,
      isRequestActive,
      connectedClient: () => requireMobileWebConnectedClient(this.options),
      terminalClientId: this.options.terminalClientId,
      nativeAuthority: this.options.nativeAuthority,
      speechAuthority: this.speechAuthority,
      hostSubscriptions: this.subscriptions,
      terminalStreams: this.terminalStreams,
      commitMessageGeneration: this.commitMessageGeneration,
      nativeChatAuthority: this.authorities.nativeChat,
      workspaceAuthority: this.authorities.workspace,
      workspaceSnapshots: this.authorities.workspaceSnapshots,
      navigationAuthority: this.options.navigationAuthority
    })
  }

  private async cancel(target: 'request' | 'subscription', id: string): Promise<void> {
    if (target === 'subscription') {
      const requestId =
        this.subscriptions.cancel(id) ??
        this.terminalStreams.cancel(id, this.options.getClient()) ??
        this.speechAuthority.cancelSubscription(id) ??
        mobileWebPendingRequestForSubscription(this.pending, id)
      if (requestId) {
        const pending = this.pending.get(requestId)
        if (pending) {
          pending.cancelled = true
          this.pending.delete(requestId)
        }
      }
      return
    }
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }
    if (mobileWebRequestSurvivesCancellation(pending)) {
      return
    }
    pending.cancelled = true
    this.pending.delete(id)
    await this.commitMessageGeneration.cancelByRequest(id)
    this.subscriptions.cancelByRequest(id)
    this.terminalStreams.cancelByRequest(id, this.options.getClient())
    this.speechAuthority.cancelByRequest(id)
    await this.messages.error(id, 'cancelled', false)
  }

  private isPending(requestId: string, pending: PendingRequest): boolean {
    return (
      !pending.cancelled &&
      !this.disposed &&
      this.options.isActive() &&
      this.pending.get(requestId) === pending
    )
  }
}
