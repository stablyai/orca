import {
  PairingGetEndpointsResultSchema,
  type DeviceResumeConfirmed
} from '../../../src/shared/mobile-relay-credential-contract'
import { MobileRelayE2eeLink } from './mobile-relay-e2ee-link'
import { MobileRelayRpcStreams } from './mobile-relay-rpc-streams'
import { waitForMobileRelayRpcConnected } from './mobile-relay-rpc-connect-wait'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'
import { markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import {
  rejectMobileRelayPendingRequests,
  type MobileRelayPendingRequest
} from './mobile-relay-pending-requests'
import {
  CONTROL_PROBE_TIMEOUT_MS,
  createMobileRelayControlProbe
} from './mobile-relay-control-probe'
import { openRpcRequestBudget, resolvePostConnectRequestTimeout } from './rpc-request-budget'
import { isRpcResponse } from './rpc-response-shape'
import type { ConnectionState, RpcResponse } from './types'
import { TimedOutControlRequestIndex } from './timed-out-control-request-index'
import { RpcApplicationResponseTracker } from './rpc-application-response-tracker'
import { RecoverableRpcError } from './recoverable-rpc-error'
import type {
  MobileRelayRpcSession,
  MobileRelayRpcSessionOptions
} from './mobile-relay-rpc-session-contract'
export type { MobileRelayRpcSession } from './mobile-relay-rpc-session-contract'

export function connectMobileRelayRpcSession(
  args: MobileRelayRpcSessionOptions
): MobileRelayRpcSession {
  const requestTimeoutMs = args.requestTimeoutMs ?? 30_000
  const pending = new Map<string, MobileRelayPendingRequest>()
  const timedOutControlRequestIds = new TimedOutControlRequestIndex()
  const applicationResponseTracker = new RpcApplicationResponseTracker(
    args.applicationResponsiveness
  )
  const stateListeners = new Set<(state: ConnectionState) => void>()
  let state: ConnectionState = 'connecting'
  let requestCounter = 0
  let controlResponseSequence = 0
  let inboundActivitySequence = 0
  const controlProbe = createMobileRelayControlProbe({
    isActive: () => !closed && state === 'connected',
    sendProbe: () =>
      sendRpc('status.get', undefined, {
        timeoutMs: CONTROL_PROBE_TIMEOUT_MS,
        probeAfterTimeout: false
      }),
    getControlResponseSequence: () => controlResponseSequence,
    getInboundActivitySequence: () => inboundActivitySequence,
    onDemote: (error) => {
      // Why: the replacement session inherits this latch, so a wedged desktop cannot
      // present each freshly authenticated relay session as healthy (issue #10385).
      applicationResponseTracker.recordControlPlaneFailure('status.get')
      fail(asError(error))
    }
  })
  let lastConnectedAt: number | null = null
  let attachDeadlineAt: number | null = null
  let resumeExpiresAt: number | null = null
  let resumeConfirmation: DeviceResumeConfirmed | null = null
  let failure: Error | null = null
  let closed = false
  const streams = new MobileRelayRpcStreams({
    nextId,
    sendFrame,
    waitForConnected: () => waitForConnected()
  })

  const link = new MobileRelayE2eeLink({
    endpoint: args.relay,
    credential: args.resumeToken,
    expectedCredentialKind: 'resume',
    deviceToken: args.deviceToken,
    desktopPublicKeyB64: args.desktopPublicKeyB64,
    createSocket: args.createSocket,
    onHello: (hello) => {
      if (
        hello.credentialKind !== 'resume' ||
        hello.acceptedCredentialVersion !== args.resumeCredentialVersion
      ) {
        fail(new Error('relay resume credential version mismatch'))
        return
      }
      attachDeadlineAt = hello.leaseExpiresAt
      resumeExpiresAt = hello.resumeExpiresAt
      publishState('handshaking')
    },
    onAuthenticated: () => void confirmResume(),
    onText: handleText,
    onBinary: handleBinary,
    onError: fail
  })

  const client: MobileRelayRpcSession = {
    async sendRequest(method, params, options) {
      const budget = openRpcRequestBudget(options)
      await waitForConnected(budget.timeoutMs)
      const timeoutError = `relay RPC timed out: ${method}`
      const timeoutMs = resolvePostConnectRequestTimeout(budget, requestTimeoutMs, timeoutError)
      return sendRpc(method, params, {
        timeoutMs,
        applicationHealthProbe: options?.applicationHealthProbe === true
      })
    },

    subscribe(method, params, listener, options) {
      if (closed) {
        return () => {}
      }
      return streams.subscribe(method, params, listener, options)
    },

    updateTerminalSubscriptionViewport(terminal, viewport) {
      streams.updateTerminalViewport(terminal, viewport)
    },
    getState: () => state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => lastConnectedAt,
    getRpcUnresponsiveSince: () => applicationResponseTracker.getUnresponsiveSince(),
    onStateChange(listener) {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    notifyForeground() {
      controlProbe.startTimer()
      controlProbe.probe()
    },
    close() {
      if (closed) {
        return
      }
      closed = true
      controlProbe.stopTimer()
      timedOutControlRequestIds.clear()
      link.close()
      rejectMobileRelayPendingRequests(pending, new Error('Client closed'))
      streams.clear()
      publishState('disconnected')
    },
    getAttachDeadlineAt: () => attachDeadlineAt,
    getResumeExpiresAt: () => resumeExpiresAt,
    getResumeConfirmation: () => resumeConfirmation,
    getFailure: () => failure
  }
  return client

  async function confirmResume(): Promise<void> {
    try {
      const response = await sendRpc(
        'pairing.getEndpoints',
        { resumeConfirmReqId: args.resumeConfirmReqId },
        { timeoutMs: requestTimeoutMs, beforeConnected: true }
      )
      if (!response.ok) {
        throw new Error(response.error.code)
      }
      const result = PairingGetEndpointsResultSchema.parse(response.result)
      if (!result.resumeConfirmation || result.relay?.relayHostId !== args.relay.relayHostId) {
        throw new Error('relay resume confirmation missing')
      }
      resumeConfirmation = result.resumeConfirmation
      resumeExpiresAt = result.resumeConfirmation.resumeExpiresAt
      lastConnectedAt = Date.now()
      publishState('connected')
      controlProbe.startTimer()
    } catch (error) {
      fail(asError(error))
    }
  }

  function sendRpc(
    method: string,
    params: unknown,
    options: {
      timeoutMs?: number
      beforeConnected?: boolean
      probeAfterTimeout?: boolean
      applicationHealthProbe?: boolean
    } = {}
  ): Promise<RpcResponse> {
    const timeoutMs = options.timeoutMs ?? requestTimeoutMs
    if (closed || (!options.beforeConnected && state !== 'connected')) {
      return Promise.reject(new RecoverableRpcError('relay session not connected'))
    }
    const id = nextId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        timedOutControlRequestIds.remember(id)
        // Why: the frame was written long ago — the desktop may have processed it.
        const error = markRpcDeliveryUnknown(new Error(`relay RPC timed out: ${method}`))
        reject(error)
        if (
          applicationResponseTracker.recordTimeout(
            id,
            method,
            state === 'connected',
            options.applicationHealthProbe === true
          )
        ) {
          fail(error)
          return
        }
        if (options.probeAfterTimeout !== false) {
          controlProbe.probe(true)
        }
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer, method })
      if (!sendFrame({ id, method, params })) {
        clearTimeout(timer)
        pending.delete(id)
        reject(new RecoverableRpcError('relay E2EE channel not ready'))
      }
    })
  }

  function sendFrame(request: { id: string; method: string; params?: unknown }): boolean {
    return link.sendText(JSON.stringify({ ...request, deviceToken: args.deviceToken }))
  }

  function handleText(plaintext: string): void {
    let value: unknown
    try {
      value = JSON.parse(plaintext)
    } catch {
      return
    }
    if (!isRpcResponse(value)) {
      return
    }
    // Why: only well-formed frames prove the desktop pipeline drains — malformed
    // payloads must neither satisfy nor extend the probe.
    inboundActivitySequence += 1
    const request = pending.get(value.id)
    const lateApplicationResponse = applicationResponseTracker.consumeLateResponse(value.id)
    if (!value.ok && value.error.code === 'unauthorized') {
      const error = new MobileE2EEAuthenticationError()
      if (request) {
        clearTimeout(request.timer)
        pending.delete(value.id)
        request.reject(error)
      }
      // Why: only the rejected request is definite; concurrent written RPCs may have executed.
      fail(error, new Error(error.message))
      return
    }
    if (
      request ||
      timedOutControlRequestIds.consume(value.id) ||
      lateApplicationResponse ||
      streams.isControlResponse(value)
    ) {
      controlResponseSequence += 1
    }
    if (request) {
      clearTimeout(request.timer)
      pending.delete(value.id)
      applicationResponseTracker.recordResponse(request.method)
      request.resolve(value)
      return
    }
    streams.handleResponse(value)
  }

  function handleBinary(bytes: Uint8Array): void {
    if (streams.handleBinary(bytes)) {
      inboundActivitySequence += 1
    }
  }

  function waitForConnected(timeoutMs = requestTimeoutMs): Promise<void> {
    return waitForMobileRelayRpcConnected({
      getState: () => state,
      subscribe: (listener) => client.onStateChange(listener),
      timeoutMs
    })
  }

  function publishState(next: ConnectionState): void {
    if (state === next) {
      return
    }
    state = next
    for (const listener of stateListeners) {
      listener(next)
    }
  }

  function fail(error: Error, pendingError = error): void {
    if (closed) {
      return
    }
    closed = true
    controlProbe.stopTimer()
    timedOutControlRequestIds.clear()
    failure = error
    link.close()
    rejectMobileRelayPendingRequests(pending, pendingError)
    publishState(error instanceof MobileE2EEAuthenticationError ? 'auth-failed' : 'disconnected')
  }

  function nextId(): string {
    return `relay-rpc-${++requestCounter}-${Date.now()}`
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
