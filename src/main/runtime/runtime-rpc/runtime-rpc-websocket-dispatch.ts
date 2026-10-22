import type { WebSocket } from 'ws'
import type {
  PairingGetEndpointsParams,
  PairingProvisionRelayParams
} from '../../../shared/mobile-relay-credential-contract'
import { callerScopeOf, devicePrincipalOf } from '../device-principal'
import { registerSocketDeviceKey } from './runtime-rpc-device-key-registration'
import type { AuthenticatedMobileSocket } from '../rpc/mobile-socket-wiring'
import type { RpcRequest, RpcResponse } from '../rpc/core'
import type { WebSocketTransport } from '../rpc/ws-transport'
import type { DeviceScope } from '../device-registry'
import { RuntimeRpcMobileDevices } from './runtime-rpc-mobile-devices'
import { classifyRuntimeLongPoll } from './runtime-rpc-long-poll'
import type { RpcBinarySender } from '../rpc/rpc-binary-sender'
import { limitRuntimeRpcReplySize } from './runtime-rpc-reply-size-limit'
import { MOBILE_RPC_METHOD_ALLOWLIST } from './runtime-rpc-mobile-method-allowlist'
import { MOBILE_RPC_METHOD_ROUTES } from './runtime-rpc-mobile-method-routing'
import { parseExecutionHostId } from '../../../shared/execution-host'

// Why: status.get has no per-connection context in the dispatcher, so stamp the scope here at the transport boundary.
function injectDeviceScope(response: string, scope: DeviceScope): string {
  try {
    const parsed = JSON.parse(response) as RpcResponse
    if (parsed.ok !== true || typeof parsed.result !== 'object' || parsed.result === null) {
      return response
    }
    ;(parsed.result as Record<string, unknown>).deviceScope = scope
    return JSON.stringify(parsed)
  } catch {
    return response
  }
}

export class RuntimeRpcWebSocketDispatch extends RuntimeRpcMobileDevices {
  // Why: a phone names a server's workspace with `executionHost`; only configured servers are reached,
  // and a target the desktop cannot reach is an error, never a silent local run.
  // Returns the request to dispatch locally, or null once it was relayed or answered.
  private relayMobileRequest(
    request: RpcRequest,
    rawMessage: string,
    reply: (response: string) => void,
    sendBinary: RpcBinarySender,
    socket: AuthenticatedMobileSocket | undefined
  ): RpcRequest | null {
    const { executionHost } = request
    if (executionHost === undefined) {
      return request
    }
    const target = parseExecutionHostId(typeof executionHost === 'string' ? executionHost : null)
    if (target?.kind === 'local' || target?.kind === 'ssh') {
      return request
    }
    // Why: the phone tags every call on a workspace screen; only this Mac's routing table decides.
    if (target && MOBILE_RPC_METHOD_ROUTES.get(request.method) !== 'execution-host') {
      return request
    }
    const local = target && this.mobileDesktopRelay?.localRequestFor(request, target.environmentId)
    if (local) {
      return local
    }
    if (!target) {
      reply(
        JSON.stringify(this.buildError(request.id, 'invalid_argument', 'Invalid executionHost'))
      )
    } else if (!socket) {
      reply(
        JSON.stringify(
          this.buildError(
            request.id,
            'remote_runtime_unavailable',
            'Servers are reachable only over an encrypted pairing'
          )
        )
      )
    } else if (!this.mobileDesktopRelay) {
      reply(
        JSON.stringify(
          this.buildError(
            request.id,
            'remote_runtime_unavailable',
            'This computer does not relay to servers'
          )
        )
      )
    } else {
      this.mobileDesktopRelay.forward(
        {
          connectionId: socket.connectionId,
          deviceId: socket.device.deviceId,
          deviceToken: socket.device.clientId,
          clientCapabilities: () => socket.clientCapabilities,
          reply,
          sendBinary: (bytes) => {
            sendBinary(bytes)
          }
        },
        target.environmentId,
        request,
        rawMessage
      )
    }
    return null
  }

  // Why: WebSocket dispatch is streaming (multiple responses) and auths via per-device tokens, not the shared token.
  protected async handleWebSocketMessage(
    rawMessage: string,
    reply: (response: string) => void,
    sendBinary: RpcBinarySender,
    wsTransport?: WebSocketTransport,
    ws?: WebSocket,
    authenticatedDeviceToken?: string | null,
    authenticatedSocket?: AuthenticatedMobileSocket
  ): Promise<void> {
    let request: RpcRequest
    try {
      request = JSON.parse(rawMessage) as RpcRequest
    } catch {
      reply(JSON.stringify(this.buildError('unknown', 'bad_request', 'Invalid JSON request')))
      return
    }

    if (typeof request.id !== 'string' || request.id.length === 0) {
      reply(JSON.stringify(this.buildError('unknown', 'bad_request', 'Missing request id')))
      return
    }
    if (typeof request.method !== 'string' || request.method.length === 0) {
      reply(JSON.stringify(this.buildError(request.id, 'bad_request', 'Missing RPC method')))
      return
    }

    const requestToken =
      typeof (request as Record<string, unknown>).deviceToken === 'string'
        ? ((request as Record<string, unknown>).deviceToken as string)
        : null
    // Why: a keyed socket proved no token, so any request token is a mismatch.
    const boundToken = authenticatedSocket
      ? (authenticatedSocket.device.deviceToken ?? null)
      : authenticatedDeviceToken
    if (requestToken && (authenticatedSocket || boundToken) && requestToken !== boundToken) {
      reply(JSON.stringify(this.buildError(request.id, 'unauthorized', 'Device token mismatch')))
      return
    }
    // Why: E2EE already authenticated the channel; authorize by that bound identity, not a repeated request field.
    const token = boundToken ?? requestToken
    if (!token && !authenticatedSocket) {
      reply(JSON.stringify(this.buildError(request.id, 'unauthorized', 'Missing device token')))
      return
    }
    // Why: an authenticated socket stays bound to the device and credential revision it proved;
    // a revoke or credential change refuses its next request even before the socket closes.
    const device = authenticatedSocket
      ? this.deviceRegistry?.resolveAuthenticatedPrincipal(authenticatedSocket.device)
      : this.deviceRegistry?.validateToken(token ?? '')
    if (!device) {
      reply(JSON.stringify(this.buildError(request.id, 'unauthorized', 'Invalid device token')))
      return
    }
    const principal = devicePrincipalOf(device)
    // Why: the dispatcher enforces this scope's permissions; it never trusts a request field.
    const callerScope = callerScopeOf(device)

    // Why: relayed calls skip this dispatcher's scope check, so only allowlisted methods may relay.
    if (device.scope === 'mobile' && MOBILE_RPC_METHOD_ALLOWLIST.has(request.method)) {
      // Why: the phone's open server sockets must see the same capabilities the desktop does.
      if (authenticatedSocket && request.method === 'runtime.clientCapabilities.update') {
        this.mobileDesktopRelay?.forwardClientCapabilities(
          authenticatedSocket.connectionId,
          rawMessage
        )
      }
      const localRequest = this.relayMobileRequest(
        request,
        rawMessage,
        reply,
        sendBinary,
        authenticatedSocket
      )
      if (!localRequest) {
        return
      }
      request = localRequest
    }

    // Why: bind the device to this socket so ws.on('close') knows which client disconnected.
    if (wsTransport && ws) {
      wsTransport.setClientId(ws, principal.deviceId)
    }

    const longPoll = classifyRuntimeLongPoll(request)
    const rejection = this.admitLongPoll(longPoll, device.deviceId)
    if (rejection) {
      reply(JSON.stringify(this.buildError(request.id, 'runtime_busy', rejection)))
      return
    }

    const abortRegistration = ws ? this.registerWebSocketDispatchAbort(ws) : null

    // Why: older pairings may lack scope metadata, so stamp the authenticated scope onto status.get.
    const boundedReply = limitRuntimeRpcReplySize(request.id, reply, (id, code, message) =>
      this.buildError(id, code, message)
    )
    const replyForRequest =
      request.method === 'status.get'
        ? (response: string): void => boundedReply(injectDeviceScope(response, device.scope))
        : boundedReply

    const connectionId = ws ? this.mobileSocketWiring?.getConnectionId(ws) : undefined
    const pairingProvider = this.mobileRelayPairingProvider
    const pairingContext =
      pairingProvider && authenticatedSocket
        ? {
            getEndpoints: (params: PairingGetEndpointsParams) =>
              pairingProvider.getEndpoints(
                {
                  deviceId: authenticatedSocket.device.deviceId,
                  connectionId: authenticatedSocket.connectionId,
                  transport: authenticatedSocket.transport
                },
                params
              ),
            provisionRelay: (params: PairingProvisionRelayParams) =>
              pairingProvider.provisionRelay(
                {
                  deviceId: authenticatedSocket.device.deviceId,
                  connectionId: authenticatedSocket.connectionId,
                  transport: authenticatedSocket.transport
                },
                params
              )
          }
        : undefined
    try {
      await this.dispatcher.dispatchStreaming(request, replyForRequest, {
        // Why: the validated credential preserves existing federation ownership without trusting request fields.
        authenticatedCallerFingerprint: principal.callerFingerprint,
        connectionId,
        clientId: principal.clientId,
        pairedDeviceId: device.deviceId,
        pairedDeviceParentId: device.parentDeviceId,
        // Why: gates the mobile-only payload diet so full-screen web/desktop clients aren't truncated.
        clientKind: device.scope,
        callerScope,
        clientCapabilities: authenticatedSocket?.clientCapabilities,
        updateClientCapabilities:
          authenticatedSocket && device.scope === 'mobile'
            ? (clientCapabilities) => {
                authenticatedSocket.clientCapabilities = clientCapabilities
              }
            : undefined,
        pairing: pairingContext,
        deviceSelf:
          authenticatedSocket && this.deviceRegistry
            ? {
                registerDeviceKey: (params) =>
                  registerSocketDeviceKey(this.deviceRegistry!, authenticatedSocket, params)
              }
            : undefined,
        mobileRelayHosts: this.mobileRelayHostCatalog ?? undefined,
        delegatedMobileDevices:
          device.scope === 'runtime'
            ? { sync: (phones) => this.syncDelegatedMobileDevices(device.deviceId, phones) }
            : undefined,
        signal: abortRegistration?.signal,
        sendBinary,
        registerBinaryStreamHandler: (streamId, handler) =>
          this.registerBinaryStreamHandler(connectionId, streamId, handler),
        registerBinaryMessageHandler: (handler) =>
          this.registerBinaryMessageHandler(connectionId, handler)
      })
    } finally {
      abortRegistration?.dispose()
      this.releaseLongPoll(longPoll, device.deviceId)
    }
  }
}
