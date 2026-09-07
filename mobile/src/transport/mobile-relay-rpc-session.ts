import {
  PairingGetEndpointsResultSchema,
  type DeviceResumeConfirmed,
  type MobileRelayEndpoint
} from '../../../src/shared/mobile-relay-credential-contract'
import { MobileRelayE2eeLink } from './mobile-relay-e2ee-link'
import { MobileRelayRpcStreams } from './mobile-relay-rpc-streams'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'
import { markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import { openRpcRequestBudget, resolvePostConnectRequestTimeout } from './rpc-request-budget'
import { isRpcResponse } from './rpc-response-shape'
import { RelayDialStageTracker, type RelayDialStageSource } from './relay-dial-stage'
import { RelayPendingRequests } from './relay-pending-requests'
import { RpcSessionLivenessWatchdog } from './rpc-session-liveness-watchdog'
import { settleMobileRuntimeCapabilities } from './mobile-runtime-capability-negotiation'
import type { RelayHostCloseReason } from '../../../src/shared/relay-host-close-reason'
import type { RpcClient } from './rpc-client'
import type { ConnectionLogSink, ConnectionState, RpcResponse } from './types'

// Ordinary foreground checks: two 4s misses, at most one voluntary probe per 10s.
const RELAY_PROBE = { timeoutMs: 4_000, missedProbeLimit: 2, minIntervalMs: 10_000 }
// A socket that died while the process was suspended must be admitted before the
// user reads the screen as broken. Two 2s misses, not one: the first frame after a
// resume rides a cold radio, and a single slow answer is not proof of a dead link.
const RELAY_RESUME_PROBE = { timeoutMs: 2_000, missedProbeLimit: 2 }
// Bounds the confirm exactly as migrateTo's own wait used to, so the supervisor's
// mutex is never held for the full request timeout waiting on a silent cell.
const RELAY_CONFIRM_TIMEOUT_MS = 12_000
// Foreground-only sweep so a silently-dead relay surfaces without a user action.
const RELAY_IDLE_PROBE_MS = 25_000
let relayRpcSessionSequence = 0

export type MobileRelayRpcSession = RpcClient &
  RelayDialStageSource & {
    // The cell's attach-reservation deadline (~10s). Diagnostics only — never
    // schedule anything from it; rotation keys off getResumeExpiresAt().
    getAttachDeadlineAt(): number | null
    getResumeExpiresAt(): number | null
    getResumeConfirmation(): DeviceResumeConfirmed | null
    // Settles once the resume confirm has answered or failed the session. Never
    // rejects. Anyone reading getResumeConfirmation()/getResumeExpiresAt() must
    // await it: 'connected' is published at authentication, ahead of the confirm.
    whenResumeConfirmed(): Promise<void>
    getFailure(): Error | null
  }

export function connectMobileRelayRpcSession(args: {
  relay: MobileRelayEndpoint
  resumeToken: string
  resumeCredentialVersion: number
  resumeConfirmReqId: string
  deviceToken: string
  desktopPublicKeyB64: string
  requestTimeoutMs?: number
  // Gates the idle liveness sweep; a backgrounded app must not spend probes.
  isForeground?: () => boolean
  createSocket?: (url: string) => WebSocket
  onHostCloseReason?: (reason: RelayHostCloseReason) => void
  onLog?: ConnectionLogSink
}): MobileRelayRpcSession {
  const requestTimeoutMs = args.requestTimeoutMs ?? 30_000
  const pending = new RelayPendingRequests()
  const stateListeners = new Set<(state: ConnectionState) => void>()
  let state: ConnectionState = 'connecting'
  let lastConnectedAt: number | null = null
  let attachDeadlineAt: number | null = null
  let resumeExpiresAt: number | null = null
  let resumeConfirmation: DeviceResumeConfirmed | null = null
  let failure: Error | null = null
  let closed = false
  let logSequence = 0
  const logSessionId = `${Date.now().toString(36)}-${(++relayRpcSessionSequence).toString(36)}`
  const livenessIdentity = {}
  // Why created here and not at authentication: handing a pre-auth caller an
  // already-resolved promise would let it read getResumeConfirmation() as null and
  // treat that as the answer. Every terminal path settles it — the confirm, fail(),
  // and close() — so awaiting it can never outlive the session.
  let settleResumeConfirmed!: () => void
  const resumeConfirmed = new Promise<void>((resolve) => {
    settleResumeConfirmed = resolve
  })
  const dialStage = new RelayDialStageTracker()
  const streams = new MobileRelayRpcStreams({
    nextId: () => pending.nextId(),
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
    onHostCloseReason: args.onHostCloseReason,
    onOpen: () => dialStage.advance('awaiting-hello'),
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
      dialStage.advance('handshaking')
      publishState('handshaking')
    },
    onAuthenticated: () => publishAuthenticated(),
    onText: (plaintext) => {
      livenessWatchdog.noteAuthenticatedInbound(livenessIdentity)
      handleText(plaintext)
    },
    onBinary: (plaintext) => {
      livenessWatchdog.noteAuthenticatedInbound(livenessIdentity)
      handleBinary(plaintext)
    },
    onError: fail
  })

  const client: MobileRelayRpcSession = {
    async sendRequest(method, params, options) {
      const budget = openRpcRequestBudget(options)
      await waitForConnected(budget.timeoutMs)
      return sendRpc(method, params, resolvePostConnectRequestTimeout(budget, requestTimeoutMs))
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
    getLastInboundAt: () => livenessWatchdog.getLastInboundAt() || null,
    onStateChange(listener) {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    notifyForeground: (reason) => {
      if (state === 'connected' && reason !== 'network-change') {
        livenessWatchdog.probeNow(livenessIdentity, reason === 'app-resume' ? 'resume' : 'nudge')
      }
    },
    close: () => terminate(new Error('Client closed')),
    getDialStage: () => dialStage.getDialStage(),
    onDialStageChange: (listener) => dialStage.onDialStageChange(listener),
    getAttachDeadlineAt: () => attachDeadlineAt,
    getResumeExpiresAt: () => resumeExpiresAt,
    getResumeConfirmation: () => resumeConfirmation,
    whenResumeConfirmed: () => resumeConfirmed,
    getFailure: () => failure
  }
  const livenessWatchdog = new RpcSessionLivenessWatchdog({
    transport: 'relay',
    idleProbeMs: RELAY_IDLE_PROBE_MS,
    probeTimeoutMs: RELAY_PROBE.timeoutMs,
    missedProbeLimit: RELAY_PROBE.missedProbeLimit,
    voluntaryProbeMinIntervalMs: RELAY_PROBE.minIntervalMs,
    urgentProbeTimeoutMs: RELAY_RESUME_PROBE.timeoutMs,
    urgentMissedProbeLimit: RELAY_RESUME_PROBE.missedProbeLimit,
    shouldIdleProbe: () => args.isForeground?.() ?? true,
    sendProbe: () =>
      state === 'connected' &&
      sendFrame({ id: pending.nextId(), method: 'status.get', params: undefined }),
    onTimeout: (evidence) => {
      args.onLog?.({
        id: `relay-liveness-${logSessionId}-${++logSequence}`,
        ts: Date.now(),
        level: 'error',
        code: 'liveness-timeout',
        path: 'relay',
        message: 'Relay health check failed',
        detail: `${evidence.reason}; ${evidence.missedProbes}/${evidence.missedProbeLimit} probes missed; last authenticated activity ${evidence.lastInboundAgeMs}ms ago`
      })
    },
    terminate: () => fail(new Error('relay session liveness timeout'))
  })
  return client

  // Why: the transport carries traffic the moment E2EE authenticates. The resume
  // confirm and the capability advisory ride it concurrently instead of putting
  // two serialized round trips in front of 'connected'.
  function publishAuthenticated(): void {
    if (closed) {
      return
    }
    dialStage.advance('confirming')
    void confirmResume().then(settleResumeConfirmed, settleResumeConfirmed)
    // Why: an unanswered advisory says nothing, but a frame that never reached the
    // wire proves the socket cannot carry traffic — that alone still fails.
    void settleMobileRuntimeCapabilities((method, params) =>
      sendRpc(method, params, requestTimeoutMs, true)
    ).catch((error: unknown) => fail(asError(error)))
    lastConnectedAt = Date.now()
    livenessWatchdog.start(livenessIdentity)
    publishState('connected')
  }

  // Off the critical path but never optional: a failed confirm or a relayHostId
  // that is not ours still fails the session, only later than it used to.
  async function confirmResume(): Promise<void> {
    try {
      const response = await sendRpc(
        'pairing.getEndpoints',
        { resumeConfirmReqId: args.resumeConfirmReqId },
        Math.min(requestTimeoutMs, RELAY_CONFIRM_TIMEOUT_MS),
        true
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
    } catch (error) {
      fail(asError(error))
    }
  }

  function sendRpc(
    method: string,
    params: unknown,
    timeoutMs = requestTimeoutMs,
    beforeConnected = false
  ): Promise<RpcResponse> {
    if (closed || (!beforeConnected && state !== 'connected')) {
      return Promise.reject(new Error('relay session not connected'))
    }
    const id = pending.nextId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.drop(id)
        // Why: the frame was written long ago — the desktop may have processed it.
        reject(markRpcDeliveryUnknown(new Error(`relay RPC timed out: ${method}`)))
      }, timeoutMs)
      pending.track(id, { resolve, reject, timer })
      if (!sendFrame({ id, method, params })) {
        clearTimeout(timer)
        pending.drop(id)
        reject(new Error('relay E2EE channel not ready'))
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
    if (pending.settle(value)) {
      return
    }
    streams.handleResponse(value)
  }

  function handleBinary(bytes: Uint8Array): void {
    streams.handleBinary(bytes)
  }

  function waitForConnected(timeoutMs = requestTimeoutMs): Promise<void> {
    if (state === 'connected') {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const unsubscribe = client.onStateChange((next) => {
        if (next === 'connected') {
          finish()
          resolve()
        } else if (next === 'disconnected' || next === 'auth-failed') {
          finish()
          reject(new Error(`relay session ${next}`))
        }
      })
      timer = setTimeout(() => {
        finish()
        reject(new Error('relay session connection timed out'))
      }, timeoutMs)
      function finish(): void {
        if (timer) {
          clearTimeout(timer)
        }
        unsubscribe()
      }
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

  // One teardown for both endings; only whether the session is to blame differs, and
  // recording a failure for a caller's close would make the establisher report a
  // deliberate teardown as a dial error.
  function terminate(error: Error): void {
    if (closed) {
      return
    }
    closed = true
    settleResumeConfirmed()
    livenessWatchdog.stop(livenessIdentity)
    streams.clear()
    link.close()
    pending.rejectAll(error)
    publishState(error instanceof MobileE2EEAuthenticationError ? 'auth-failed' : 'disconnected')
  }

  function fail(error: Error): void {
    if (!closed) {
      failure = error
    }
    terminate(error)
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
