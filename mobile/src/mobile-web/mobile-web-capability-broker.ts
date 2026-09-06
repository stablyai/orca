import {
  MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS,
  type MobileWebBridgePageMessage,
  type MobileWebResumeRoute
} from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import {
  isRetryableMobileWebBridgeError,
  MobileWebBrokerError,
  mobileWebBridgeErrorCode
} from './mobile-web-broker-error'
import { MobileWebOperationRateLimiter } from './mobile-web-operation-rate-limiter'
import { MobileWebCommitMessageGeneration } from './mobile-web-commit-message-generation'
import { MobileWebCapabilitySubscriptions } from './mobile-web-capability-subscriptions'
import { MOBILE_WEB_PRODUCTION_GRANT_INDEX } from './mobile-web-production-grants'
import { MobileWebTerminalStreams } from './mobile-web-terminal-streams'
import { MOBILE_WEB_TERMINAL_CLIENT_CLOSURE } from './mobile-web-terminal-stream-retirement'
import { MobileWebSpeechAuthority } from './mobile-web-speech-authority'
import { executeMobileWebCapabilityRequest } from './mobile-web-capability-execution'
import { MobileWebCapabilityAuthorities } from './mobile-web-capability-authorities'
import type { MobileWebCapabilityBrokerOptions } from './mobile-web-capability-broker-options'
import { MobileWebBrokerMessageSender } from './mobile-web-broker-message-sender'
import { MobileWebBrokerReplayGuard } from './mobile-web-broker-replay-guard'
import { rememberMobileWebBrokerRoute } from './mobile-web-broker-route-memory'
import { resolveMobileWebHostNavigationRoute } from './mobile-web-host-navigation-route'
import {
  mobileWebEncodedByteLength,
  mobileWebAgentHistoryContinuation,
  mobileWebOperationKey,
  mobileWebPendingForOperation,
  mobileWebPendingRequestForSubscription,
  mobileWebRequestExpectsSubscription,
  mobileWebWorkspaceSnapshotContinuation
} from './mobile-web-request-accounting'

type PageRequest = Extract<MobileWebBridgePageMessage, { type: 'request' }>
type PendingRequest = { operationKey: string; subscriptionId?: string; cancelled: boolean }

// Native alerts outlive client churn and explicit cancels; the OS dialog owns the resolution.
function survivesCancellation(pending: PendingRequest): boolean {
  return pending.operationKey === 'native.alert'
}
export class MobileWebCapabilityBroker {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly replay = new MobileWebBrokerReplayGuard()
  private readonly subscriptions: MobileWebCapabilitySubscriptions
  private readonly terminalStreams: MobileWebTerminalStreams
  private readonly speechAuthority: MobileWebSpeechAuthority
  private readonly rateLimiter: MobileWebOperationRateLimiter
  private readonly commitMessageGeneration = new MobileWebCommitMessageGeneration()
  private readonly authorities: MobileWebCapabilityAuthorities
  private readonly messages: MobileWebBrokerMessageSender
  private disposed = false

  constructor(private readonly options: MobileWebCapabilityBrokerOptions) {
    this.rateLimiter = new MobileWebOperationRateLimiter(options.now ?? Date.now)
    this.authorities = new MobileWebCapabilityAuthorities(options)
    this.messages = new MobileWebBrokerMessageSender({
      context: options.context,
      isActive: () => !this.disposed && options.isActive(),
      postMessage: options.postMessage
    })
    const posts = this.messages.subscriptionPosts()
    this.subscriptions = new MobileWebCapabilitySubscriptions({
      ...posts,
      browserAuthority: this.authorities.browser,
      nativeChatAuthority: this.authorities.nativeChat,
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
    this.authorities.clear()
    this.commitMessageGeneration.replaceClient(client)
    // The page document outlives the swap, so every live subscription needs a terminal frame; a
    // silent teardown leaves it waiting on a feed the new client will never resume.
    this.subscriptions.closeAll({ code: 'unavailable', retryable: true })
    this.terminalStreams.dispose(null, MOBILE_WEB_TERMINAL_CLIENT_CLOSURE)
    this.speechAuthority.replaceClient()
    for (const [requestId, pending] of this.pending) {
      if (survivesCancellation(pending)) {
        continue
      }
      pending.cancelled = true
      this.pending.delete(requestId)
      void this.messages.error(requestId, 'cancelled', false)
    }
  }
  updateConnectionState(state: 'connecting' | 'connected' | 'offline' | 'recovering'): void {
    if (state === 'connected') {
      return
    }
    this.authorities.terminalArtifact.clear()
    void this.speechAuthority.cancel('disconnected')
  }
  updateAppForegroundState(foreground: boolean): void {
    if (!foreground) {
      this.speechAuthority.cancelForAppBackground()
    }
  }
  rememberRoute(route: MobileWebResumeRoute): void {
    rememberMobileWebBrokerRoute(
      !this.disposed && this.options.isActive(),
      route,
      this.authorities.workspace,
      this.options
    )
  }
  async resolveNavigationRoute(hostWorkspaceId: string): Promise<MobileWebResumeRoute> {
    if (this.disposed || !this.options.isActive()) {
      throw new MobileWebBrokerError('cancelled')
    }
    return resolveMobileWebHostNavigationRoute(
      hostWorkspaceId,
      this.connectedClient(),
      this.authorities.workspace
    )
  }
  private async handleRequest(request: PageRequest): Promise<void> {
    if (!this.replay.acceptRequest(request.requestId, this.pending.has(request.requestId))) {
      await this.messages.error(request.requestId, 'invalid_request', false)
      return
    }

    const grant = MOBILE_WEB_PRODUCTION_GRANT_INDEX.get(mobileWebOperationKey(request))
    const expectsSubscription = mobileWebRequestExpectsSubscription(request)
    if (!grant || (request.mode === 'subscription') !== expectsSubscription) {
      await this.messages.error(request.requestId, 'unsupported_capability', false)
      return
    }
    if (
      request.mode === 'subscription' &&
      !this.replay.acceptSubscription(request.subscriptionId)
    ) {
      await this.messages.error(request.requestId, 'invalid_request', false)
      return
    }
    if (mobileWebEncodedByteLength(request.payload) > grant.limits.maxRequestBytes) {
      await this.messages.error(request.requestId, 'too_large', false)
      return
    }
    if (
      this.pending.size >= MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS ||
      mobileWebPendingForOperation(this.pending.values(), mobileWebOperationKey(request)) +
        this.subscriptions.countForOperation(mobileWebOperationKey(request)) +
        this.terminalStreams.countForOperation(mobileWebOperationKey(request)) +
        this.speechAuthority.countForOperation(mobileWebOperationKey(request)) >=
        grant.limits.maxConcurrent
    ) {
      await this.messages.error(request.requestId, 'rate_limited', true)
      return
    }
    const branchCompareContinuation =
      this.authorities.sourceControlBranchCompare.claimRequestContinuation(request)
    if (
      !mobileWebWorkspaceSnapshotContinuation(request) &&
      !mobileWebAgentHistoryContinuation(request) &&
      !branchCompareContinuation &&
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
    try {
      const payload = await this.execute(request, () => this.isPending(request.requestId, pending))
      if (!this.isPending(request.requestId, pending)) {
        return
      }
      this.pending.delete(request.requestId)
      await (mobileWebEncodedByteLength(payload) > grant.limits.maxResponseBytes
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
      this.authorities.sourceControlBranchCompare.releaseClaim(request.requestId)
      if (this.pending.get(request.requestId) === pending) {
        this.pending.delete(request.requestId)
      }
    }
  }

  private async execute(request: PageRequest, isRequestActive: () => boolean): Promise<unknown> {
    return executeMobileWebCapabilityRequest({
      request,
      isRequestActive,
      connectedClient: () => this.connectedClient(),
      terminalClientId: this.options.terminalClientId,
      nativeAuthority: this.options.nativeAuthority,
      agentHistoryAuthority: this.authorities.agentHistory,
      agentHistoryPager: this.authorities.agentHistoryPager,
      agentHistoryResume: this.authorities.agentHistoryResume,
      accountSubscriptions: this.subscriptions.account,
      browserStreams: this.subscriptions.browser,
      nativeChatSubscriptions: this.subscriptions.nativeChat,
      sessionSubscriptions: this.subscriptions.session,
      sourceControlSubscriptions: this.subscriptions.sourceControl,
      sourceControlBranchCompare: this.authorities.sourceControlBranchCompare,
      speechAuthority: this.speechAuthority,
      workspaceSubscriptions: this.subscriptions.workspace,
      terminalStreams: this.terminalStreams,
      commitMessageGeneration: this.commitMessageGeneration,
      browserAuthority: this.authorities.browser,
      nativeChatAuthority: this.authorities.nativeChat,
      terminalArtifactAuthority: this.authorities.terminalArtifact,
      taskTargetAuthority: this.authorities.taskTarget,
      taskProjectTable: this.authorities.taskProjectTable,
      workspaceAuthority: this.authorities.workspace,
      workspaceSnapshots: this.authorities.workspaceSnapshots,
      navigationAuthority: this.options.navigationAuthority
    })
  }

  private connectedClient(): RpcClient {
    if (!this.options.isConnected()) {
      throw new MobileWebBrokerError('not_connected')
    }
    const client = this.options.getClient()
    if (!client) {
      throw new MobileWebBrokerError('not_connected')
    }
    return client
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
    if (survivesCancellation(pending)) {
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
