// One authenticated device's call, once its message is parsed and routed: shared by full pairings and
// teammates' share devices, which get only what `dispatchForDevice` gives every device.
import { parseRuntimeClientCapabilities } from '../callers/runtime-client-capabilities'
import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import type { DeviceScope } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RpcCallerScope } from '../callers/rpc-caller-scope'
import type { RpcRequest, RpcResponse } from '../core'
import type { RpcDispatchStreamingOptions } from '../dispatch/dispatcher-stream-options'
import type { AuthenticatedMobileSocket } from '../mobile/mobile-socket-wiring'
import type { RpcBinarySender } from '../transports/rpc-binary-sender'
import type { DeviceEntry } from './pairing/device-entry'
import {
  botShareCallerScopeOf,
  botSharePrincipalOf,
  type DevicePrincipal
} from './pairing/device-principal'
import type { BotShareDevice } from './pairing/bot-share-device-store'
import type {
  ConnectorDelivery,
  ConnectorDeliveryResult
} from '../../../../shared/connectors/connector-cloud-contract'
import { deliverBotShareHeldMessage } from '../../../bots/team-share/bot-share-held-messages'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime/remote-runtime-client-capabilities'
import { registerSocketDeviceKey } from './runtime-rpc-device-key-registration'
import { injectDeviceScope } from './runtime-rpc-device-scope-stamp'
import { classifyRuntimeLongPoll } from './runtime-rpc-long-poll'
import { RuntimeRpcMobileDevices } from './runtime-rpc-mobile-devices'
import { exchangeSocketPairingTicket } from './runtime-rpc-pairing-ticket-exchange'
import { createPairingDirectEndpointsReader } from './pairing/network/pairing-direct-endpoints'
import { socketPairingRpcContext } from './runtime-rpc-socket-pairing-context'
import { limitRuntimeRpcReplySize } from './runtime-rpc-reply-size-limit'
import { RuntimeRpcStagedReplies } from './runtime-rpc-staged-replies'
import type { OpenedBinaryChannel } from './runtime-binary-channels'
import { isEndResult } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-protocol'
import {
  isBinaryChannelNumber,
  RUNTIME_BINARY_CHANNELS_CAPABILITY
} from '../../../../shared/remote-runtime/protocol/runtime-binary-channel'

type PairedDeviceContext = Pick<
  RpcDispatchStreamingOptions,
  | 'updateClientCapabilities'
  | 'deviceSelf'
  | 'mobileRelayHosts'
  | 'peerDesktops'
  | 'delegatedMobileDevices'
  | 'pairingDirectEndpoints'
>

export class RuntimeRpcDeviceDispatch extends RuntimeRpcMobileDevices {
  protected readonly stagedReplies = new RuntimeRpcStagedReplies(() => this.runtime.getRuntimeId())
  private readonly readPairingDirectEndpoints = createPairingDirectEndpointsReader(
    () => this.transports.find((transport) => transport.kind === 'websocket')?.endpoint ?? null
  )

  /** What only a full pairing gets: its own credential and account, its phones, its peers. */
  protected pairedDeviceContext(
    device: DeviceEntry,
    authenticatedSocket: AuthenticatedMobileSocket | undefined,
    ws: WebSocket | undefined
  ): PairedDeviceContext {
    return {
      updateClientCapabilities:
        authenticatedSocket && device.scope === 'mobile'
          ? (clientCapabilities) => {
              authenticatedSocket.clientCapabilities = clientCapabilities
            }
          : undefined,
      deviceSelf:
        authenticatedSocket && this.deviceRegistry
          ? {
              registerDeviceKey: (params) =>
                registerSocketDeviceKey(this.deviceRegistry!, authenticatedSocket, params),
              exchangePairingTicket: (params) =>
                exchangeSocketPairingTicket(this.deviceRegistry!, authenticatedSocket, params),
              ...this.desktopAccountSelf(device, authenticatedSocket.connectionId)
            }
          : undefined,
      pairingDirectEndpoints:
        authenticatedSocket && device.scope === 'mobile'
          ? this.readPairingDirectEndpoints
          : undefined,
      mobileRelayHosts: this.mobileRelayHostCatalog ?? undefined,
      // Only an authenticated desktop socket can say which installation it is.
      peerDesktops:
        device.scope === 'runtime' && authenticatedSocket
          ? {
              list: (clientInstanceId) =>
                this.declaredDesktopClients.peers(
                  { connectionId: authenticatedSocket.connectionId, clientInstanceId },
                  (deviceId) => this.deviceRegistry?.getDevice(deviceId) ?? null
                ),
              declare: (clientInstanceId) =>
                this.declaredDesktopClients.declare(
                  authenticatedSocket.connectionId,
                  device.deviceId,
                  clientInstanceId
                )
            }
          : undefined,
      delegatedMobileDevices:
        device.scope === 'runtime'
          ? {
              sync: (phones) =>
                this.syncDelegatedMobileDevices(
                  device.deviceId,
                  phones,
                  ws ? this.mobileSocketWiring?.getConnectionId(ws) : undefined
                )
            }
          : undefined
    }
  }

  /** One authenticated device's call: long-poll budget, reply bounds, its own connection's Relay
   *  credential, then dispatch under its proven scope. `paired` holds what only a full pairing gets. */
  protected async dispatchForDevice(
    request: RpcRequest,
    reply: (response: string) => void,
    sendBinary: RpcBinarySender,
    ws: WebSocket | undefined,
    authenticatedSocket: AuthenticatedMobileSocket | undefined,
    device: {
      deviceId: string
      parentDeviceId: string | undefined
      scope: DeviceScope
      principal: DevicePrincipal
      callerScope: RpcCallerScope
    },
    paired: Pick<
      RpcDispatchStreamingOptions,
      | 'updateClientCapabilities'
      | 'deviceSelf'
      | 'mobileRelayHosts'
      | 'peerDesktops'
      | 'delegatedMobileDevices'
    > = {}
  ): Promise<void> {
    const { principal, callerScope } = device

    const longPoll = classifyRuntimeLongPoll(request)
    const rejection = this.admitLongPoll(longPoll, device.deviceId)
    if (rejection) {
      reply(JSON.stringify(this.buildError(request.id, 'runtime_busy', rejection)))
      return
    }

    const abortRegistration = ws ? this.registerWebSocketDispatchAbort(ws) : null

    // Older pairings lack scope metadata; stamp authenticated scope on status.get.
    const boundedReply = limitRuntimeRpcReplySize(
      request.id,
      reply,
      (id, code, message) => this.buildError(id, code, message),
      this.stagedReplies.stagerFor(
        authenticatedSocket?.clientCapabilities,
        request.id,
        device.deviceId,
        abortRegistration?.signal
      )
    )
    const replyForRequest =
      request.method === 'status.get'
        ? (response: string): boolean => boundedReply(injectDeviceScope(response, device.scope))
        : boundedReply

    const socketConnectionId = ws ? this.mobileSocketWiring?.getConnectionId(ws) : undefined
    const channel = this.openRequestBinaryChannel(
      request,
      socketConnectionId,
      authenticatedSocket,
      sendBinary
    )
    if (channel && 'error' in channel) {
      abortRegistration?.dispose()
      this.releaseLongPoll(longPoll, device.deviceId)
      reply(JSON.stringify(this.buildError(request.id, 'bad_request', channel.error)))
      return
    }
    // A stream on a channel lives until a reply ends it (an answer, an error or `end`; the client
    // ends it there too), the client closes the channel, or the socket closes. A subscribe handler
    // returns once it registers, so its return is not the stream's end.
    const sendReply = (response: RpcResponse): void => {
      const whole = replyForRequest(JSON.stringify(response))
      if (!whole || !response.ok || !response.streaming || isEndResult(response.result)) {
        channel?.release()
      }
    }
    // A stream on a binary channel is its own connection, as if it had a socket of its own.
    const connectionId = channel?.connectionId ?? socketConnectionId
    const signal =
      channel && abortRegistration
        ? AbortSignal.any([abortRegistration.signal, channel.signal])
        : (channel?.signal ?? abortRegistration?.signal)
    try {
      await this.dispatcher.dispatchStreamingObjects(request, sendReply, {
        // Validated credentials preserve federation ownership without trusting request fields.
        authenticatedCallerFingerprint: principal.callerFingerprint,
        connectionId,
        clientId: principal.clientId,
        pairedDeviceId: device.deviceId,
        pairedDeviceParentId: device.parentDeviceId,
        // Diet only mobile payloads; retain full web/desktop replies.
        clientKind: device.scope,
        callerScope,
        // A stream on a channel reads by what its own socket would have declared.
        clientCapabilities:
          channel?.capabilities.current ?? authenticatedSocket?.clientCapabilities,
        capabilitySource: channel?.capabilities ?? authenticatedSocket?.capabilitySource,
        pairing: socketPairingRpcContext(this.mobileRelayPairingProvider, authenticatedSocket),
        ...paired,
        signal,
        sendBinary: channel?.sendBinary ?? sendBinary,
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

  private openRequestBinaryChannel(
    request: RpcRequest,
    socketConnectionId: string | undefined,
    authenticatedSocket: AuthenticatedMobileSocket | undefined,
    sendBinary: RpcBinarySender
  ): OpenedBinaryChannel | { error: string } | null {
    if (request.binaryChannel === undefined) {
      return null
    }
    if (
      !socketConnectionId ||
      !authenticatedSocket?.clientCapabilities.includes(RUNTIME_BINARY_CHANNELS_CAPABILITY)
    ) {
      return { error: 'Binary channels are not available on this connection.' }
    }
    if (!isBinaryChannelNumber(request.binaryChannel)) {
      return { error: 'Binary channel must be an integer from 1 to 2^32-1.' }
    }
    // Its own socket declared the stream's capabilities; without them it reads by this socket's.
    const capabilities = Array.isArray(request.binaryChannelCapabilities)
      ? parseRuntimeClientCapabilities(request.binaryChannelCapabilities)
      : authenticatedSocket.clientCapabilities
    return this.binaryChannels.open(
      socketConnectionId,
      request.binaryChannel,
      sendBinary,
      capabilities
    )
  }

  /** A teammate's message held while this host was away: see `deliverBotShareHeldMessage`. */
  async deliverBotShareHeldMessage(
    delivery: Extract<ConnectorDelivery, { kind: 'share_send' }>
  ): Promise<ConnectorDeliveryResult> {
    const devices = this.botShareDevices
    if (!devices) {
      return { outcome: 'refused', reason: 'unknown_device' }
    }
    return await deliverBotShareHeldMessage(
      {
        hostKeypair: this.e2eeKeypair,
        bots: this.runtime.bots,
        devices,
        call: (device, method, params) => this.callAsBotShareDevice(device, method, params),
        fence: (sessionId) =>
          getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)?.currentFence ??
          null
      },
      delivery
    )
  }

  /** One call as a share device with no socket (its held message), admitted as its socket's calls
   *  are: the share allowlist and guard, then the handler. */
  protected async callAsBotShareDevice(
    device: BotShareDevice,
    method: string,
    params: unknown
  ): Promise<unknown> {
    const principal = botSharePrincipalOf(device)
    const clientCapabilities = remoteRuntimeClientCapabilities(
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    const response = await this.dispatcher.dispatch(
      { id: randomUUID(), authToken: '', method, params },
      {
        authenticatedCallerFingerprint: principal.callerFingerprint,
        clientId: principal.clientId,
        pairedDeviceId: device.deviceId,
        pairedDeviceParentId: device.parentDeviceId,
        // As the teammate's desktop would send it live: its handshake's capabilities, which take a
        // send's answer at acceptance.
        clientKind: 'runtime',
        callerScope: botShareCallerScopeOf(device, clientCapabilities),
        clientCapabilities
      }
    )
    if (!response.ok) {
      throw new Error(response.error.message || response.error.code)
    }
    return response.result
  }
}
