import {
  PairingGetEndpointsResultSchema,
  type DeviceResumeConfirmed,
  type MobileRelayEndpoint
} from '../../../src/shared/mobile-relay-credential-contract'
import { MobileRelayE2eeLink } from './mobile-relay-e2ee-link'
import { MobileRelayRpcStreams } from './mobile-relay-rpc-streams'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'
import { isRpcResponse } from './rpc-response-shape'
import type { RpcClient } from './rpc-client'
import type { ConnectionState, RpcResponse } from './types'

type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type MobileRelayRpcSession = RpcClient & {
  getLeaseExpiresAt(): number | null
  getResumeConfirmation(): DeviceResumeConfirmed | null
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
  createSocket?: (url: string) => WebSocket
}): MobileRelayRpcSession {
  const requestTimeoutMs = args.requestTimeoutMs ?? 30_000
  const pending = new Map<string, PendingRequest>()
  const stateListeners = new Set<(state: ConnectionState) => void>()
  let state: ConnectionState = 'connecting'
  let requestCounter = 0
  let lastConnectedAt: number | null = null
  let leaseExpiresAt: number | null = null
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
      leaseExpiresAt = hello.leaseExpiresAt
      publishState('handshaking')
    },
    onAuthenticated: () => void confirmResume(),
    onText: handleText,
    onBinary: handleBinary,
    onError: fail
  })

  const client: MobileRelayRpcSession = {
    async sendRequest(method, params, options) {
      await waitForConnected(options?.timeoutMs)
      return sendRpc(method, params, options?.timeoutMs)
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
    onStateChange(listener) {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    notifyForeground: () => {},
    close() {
      if (closed) {
        return
      }
      closed = true
      link.close()
      rejectPending(new Error('Client closed'))
      streams.clear()
      publishState('disconnected')
    },
    getLeaseExpiresAt: () => leaseExpiresAt,
    getResumeConfirmation: () => resumeConfirmation,
    getFailure: () => failure
  }
  return client

  async function confirmResume(): Promise<void> {
    try {
      const response = await sendRpc(
        'pairing.getEndpoints',
        { resumeConfirmReqId: args.resumeConfirmReqId },
        requestTimeoutMs,
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
      lastConnectedAt = Date.now()
      publishState('connected')
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
    const id = nextId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`relay RPC timed out: ${method}`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      if (!sendFrame({ id, method, params })) {
        clearTimeout(timer)
        pending.delete(id)
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
    const request = pending.get(value.id)
    if (request) {
      clearTimeout(request.timer)
      pending.delete(value.id)
      request.resolve(value)
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

  function fail(error: Error): void {
    if (closed) {
      return
    }
    closed = true
    failure = error
    link.close()
    rejectPending(error)
    publishState(error instanceof MobileE2EEAuthenticationError ? 'auth-failed' : 'disconnected')
  }

  function rejectPending(error: Error): void {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }

  function nextId(): string {
    return `relay-rpc-${++requestCounter}-${Date.now()}`
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
