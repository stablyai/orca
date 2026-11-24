import type { WebSocket } from 'ws'
import {
  botShareCallerScopeOf,
  botSharePrincipalOf,
  callerScopeOf,
  devicePrincipalOf
} from './pairing/device-principal'
import type { AuthenticatedMobileSocket } from '../mobile/mobile-socket-wiring'
import type { RpcRequest } from '../core'
import type { WebSocketTransport } from '../transports/websocket/ws-transport'
import { RuntimeRpcDeviceDispatch } from './runtime-rpc-device-dispatch'
import type { RpcBinarySender } from '../transports/rpc-binary-sender'
import { MOBILE_RPC_METHOD_ALLOWLIST } from './runtime-rpc-mobile-method-allowlist'
import { MOBILE_RPC_METHOD_ROUTES } from './runtime-rpc-mobile-method-routing'
import { isUntaggedTrackerCall, withDefaultScopeServer } from './runtime-rpc-mobile-tracker-methods'
import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { WorktreeRemove } from '../../../../shared/rpc-contract/workspaces/worktree-params'

export class RuntimeRpcWebSocketDispatch extends RuntimeRpcDeviceDispatch {
  // Relay only to configured execution hosts; unreachable targets fail, never run locally. Return null after relay/reply.
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
    if (target?.kind === 'runtime' && request.method === 'worktree.rm') {
      const params = WorktreeRemove.safeParse({
        ...(typeof request.params === 'object' && request.params !== null ? request.params : {}),
        hostId: target.id
      })
      try {
        if (params.success && this.runtime.ownsRecipeWorkspaceRemoval?.(params.data)) {
          return { ...request, params: params.data }
        }
      } catch (error) {
        // Ambiguous ownership must answer the phone instead of leaving it waiting.
        reply(
          JSON.stringify(
            this.buildError(
              request.id,
              'invalid_argument',
              error instanceof Error ? error.message : String(error)
            )
          )
        )
        return null
      }
    }
    // Phone workspace tags cannot choose routing; only this Mac's table does.
    if (target && MOBILE_RPC_METHOD_ROUTES.get(request.method) === 'paired-desktop') {
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
    const share = authenticatedSocket?.device.botShare
    if (authenticatedSocket && share) {
      // A share socket is checked against its own store only, and gets none of a pairing's powers.
      const shareDevice = this.botShareDevices?.resolveAuthenticatedPrincipal(
        authenticatedSocket.device.deviceId,
        share
      )
      if (!shareDevice) {
        reply(JSON.stringify(this.buildError(request.id, 'unauthorized', 'Invalid device')))
        return
      }
      if (this.stagedReplies.answerRead(request, shareDevice.deviceId, reply)) {
        return
      }
      await this.dispatchForDevice(request, reply, sendBinary, ws, authenticatedSocket, {
        deviceId: shareDevice.deviceId,
        parentDeviceId: shareDevice.parentDeviceId,
        scope: shareDevice.scope,
        principal: botSharePrincipalOf(shareDevice),
        callerScope: botShareCallerScopeOf(shareDevice)
      })
      return
    }
    // E2EE already proves channel identity; request fields cannot substitute credentials.
    const token = boundToken ?? requestToken
    if (!token && !authenticatedSocket) {
      reply(JSON.stringify(this.buildError(request.id, 'unauthorized', 'Missing device token')))
      return
    }
    // Recheck device/credential revision per request so revocation refuses immediately, before socket close.
    const device = authenticatedSocket
      ? this.deviceRegistry?.resolveAuthenticatedPrincipal(authenticatedSocket.device)
      : this.deviceRegistry?.validateToken(token ?? '')
    if (!device) {
      reply(JSON.stringify(this.buildError(request.id, 'unauthorized', 'Invalid device token')))
      return
    }
    const principal = devicePrincipalOf(device)
    if (this.stagedReplies.answerRead(request, device.deviceId, reply)) {
      return
    }
    // Use authenticated scope for dispatcher permissions, never request scope.
    const callerScope = callerScopeOf(device)

    // Relay bypasses local dispatcher checks; admit only mobile-allowlisted methods.
    if (device.scope === 'mobile' && MOBILE_RPC_METHOD_ALLOWLIST.has(request.method)) {
      // Forward desktop-negotiated capabilities to phone server sockets.
      if (authenticatedSocket && request.method === 'runtime.clientCapabilities.update') {
        this.mobileDesktopRelay?.forwardClientCapabilities(
          authenticatedSocket.connectionId,
          rawMessage
        )
      }
      // A phone relayed in from another desktop already got that desktop's default host.
      if (isUntaggedTrackerCall(request) && authenticatedSocket && !device.parentDeviceId) {
        request = await withDefaultScopeServer(request, this.runtime, this.mobileRelayHostCatalog)
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
    await this.dispatchForDevice(
      request,
      reply,
      sendBinary,
      ws,
      authenticatedSocket,
      {
        deviceId: device.deviceId,
        parentDeviceId: device.parentDeviceId,
        scope: device.scope,
        principal,
        callerScope
      },
      this.pairedDeviceContext(device, authenticatedSocket, ws)
    )
  }
}
