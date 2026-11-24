// One authenticated device's call, once its message is parsed and routed: shared by full pairings and
// teammates' share devices, which get only what `dispatchForDevice` gives every device.
import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import type {
  PairingGetEndpointsParams,
  PairingProvisionRelayParams
} from '../../../../shared/remote-runtime/relay/mobile-relay-credential-contract'
import type { DeviceScope } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RpcCallerScope } from '../callers/rpc-caller-scope'
import type { RpcRequest } from '../core'
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
import { openBotShareNewChat } from '../../../bots/team-share/bot-share-new-chats'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime/remote-runtime-client-capabilities'
import { registerSocketDeviceKey } from './runtime-rpc-device-key-registration'
import { injectDeviceScope } from './runtime-rpc-device-scope-stamp'
import { classifyRuntimeLongPoll } from './runtime-rpc-long-poll'
import { RuntimeRpcMobileDevices } from './runtime-rpc-mobile-devices'
import { exchangeSocketPairingTicket } from './runtime-rpc-pairing-ticket-exchange'
import { limitRuntimeRpcReplySize } from './runtime-rpc-reply-size-limit'
import { RuntimeRpcStagedReplies } from './runtime-rpc-staged-replies'

type PairedDeviceContext = Pick<
  RpcDispatchStreamingOptions,
  | 'updateClientCapabilities'
  | 'deviceSelf'
  | 'mobileRelayHosts'
  | 'peerDesktops'
  | 'delegatedMobileDevices'
>

export class RuntimeRpcDeviceDispatch extends RuntimeRpcMobileDevices {
  protected readonly stagedReplies = new RuntimeRpcStagedReplies(() => this.runtime.getRuntimeId())

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
        // Validated credentials preserve federation ownership without trusting request fields.
        authenticatedCallerFingerprint: principal.callerFingerprint,
        connectionId,
        clientId: principal.clientId,
        pairedDeviceId: device.deviceId,
        pairedDeviceParentId: device.parentDeviceId,
        // Diet only mobile payloads; retain full web/desktop replies.
        clientKind: device.scope,
        callerScope,
        clientCapabilities: authenticatedSocket?.clientCapabilities,
        capabilitySource: authenticatedSocket?.capabilitySource,
        pairing: pairingContext,
        ...paired,
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
          null,
        newChat: (key, start) => openBotShareNewChat(this.runtime.getOrchestrationDb(), key, start)
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
        callerScope: botShareCallerScopeOf(device),
        clientCapabilities: remoteRuntimeClientCapabilities(
          ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
        )
      }
    )
    if (!response.ok) {
      throw new Error(response.error.message || response.error.code)
    }
    return response.result
  }
}
