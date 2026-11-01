import type { WebSocket } from 'ws'
import type { TerminalStreamFrame } from '../../../shared/terminal-stream-protocol'
import { RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY } from '../../../shared/mobile-desktop-relay-contract'
import type { RelayedStreamCaller } from '../mobile-desktop-relay/relayed-client-stream-admission'
import type { AuthenticatedMobileSocket } from '../rpc/mobile-socket-wiring'
import { DeviceRegistry } from '../device-registry'
import { loadOrCreateE2EEKeypair, type E2EEKeypair } from '../e2ee-keypair'
import { RuntimeRpcState } from './runtime-rpc-state'
import {
  DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE,
  E2EE_KEY_UNAVAILABLE_GUIDANCE,
  pairingUnavailable,
  type PairingIdentityInitialization
} from './runtime-rpc-pairing-types'

export type RuntimeClientRelayCaller = RelayedStreamCaller & {
  onServerResolved: (environmentId: string) => void
}

export class RuntimeRpcBinaryRouting extends RuntimeRpcState {
  protected runtimeClientRelayCaller(
    socket: AuthenticatedMobileSocket,
    deviceId: string
  ): RuntimeClientRelayCaller {
    return {
      // Mint this client a device only on a server it actually reached.
      onServerResolved: (environmentId) => this.relayedRuntimeClients.add(environmentId, deviceId),
      // Both sides negotiate relayed binary frames; a client that only knows the relay keeps its refusal.
      carriesClientStreams: socket.clientCapabilities.includes(
        RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY
      ),
      hasLocalBinaryStreams: () => this.binaryMessageRouter.hasHandlers(socket.connectionId)
    }
  }

  protected registerBinaryStreamHandler(
    connectionId: string | undefined,
    streamId: number,
    handler: (frame: TerminalStreamFrame) => void
  ): () => void {
    this.assertNoRelayedClientStreams(connectionId)
    return this.binaryMessageRouter.registerTerminalStream(connectionId, streamId, handler)
  }

  protected registerBinaryMessageHandler(
    connectionId: string | undefined,
    handler: (bytes: Uint8Array<ArrayBufferLike>) => void
  ): () => void {
    this.assertNoRelayedClientStreams(connectionId)
    return this.binaryMessageRouter.registerRawMessage(connectionId, handler)
  }

  protected handleWebSocketBinaryMessage(bytes: Uint8Array<ArrayBufferLike>, ws: WebSocket): void {
    const connectionId = this.mobileSocketWiring?.getConnectionId(ws)
    // A relayed multiplex owns its connection's binary lane; every other connection stays local.
    if (connectionId && this.mobileDesktopRelay?.forwardClientBinary(connectionId, bytes)) {
      return
    }
    this.binaryMessageRouter.dispatch(connectionId, bytes)
  }

  // Frames on a relayed lane never reach local handlers, so a local stream there would hang silently.
  private assertNoRelayedClientStreams(connectionId: string | undefined): void {
    if (connectionId && this.mobileDesktopRelay?.carriesClientStreams(connectionId)) {
      throw new Error('binary_handler_mode_conflict')
    }
  }

  protected registerWebSocketDispatchAbort(ws: WebSocket): {
    signal: AbortSignal
    dispose: () => void
  } {
    const abortController = new AbortController()
    if (ws.readyState !== ws.OPEN) {
      abortController.abort()
      return { signal: abortController.signal, dispose: () => {} }
    }

    let state = this.wsDispatchAbortStates.get(ws)
    if (!state) {
      state = {
        controllers: new Set(),
        abortOnClose: () => this.abortWebSocketDispatches(ws)
      }
      this.wsDispatchAbortStates.set(ws, state)
      // Why: many streaming RPCs share one WebSocket; one socket-level abort fan-out avoids MaxListenersExceededWarning.
      ws.on('close', state.abortOnClose)
      ws.on('error', state.abortOnClose)
    }
    state.controllers.add(abortController)

    return {
      signal: abortController.signal,
      dispose: () => {
        const current = this.wsDispatchAbortStates.get(ws)
        if (!current) {
          return
        }
        current.controllers.delete(abortController)
        if (current.controllers.size > 0) {
          return
        }
        this.wsDispatchAbortStates.delete(ws)
        ws.off('close', current.abortOnClose)
        ws.off('error', current.abortOnClose)
      }
    }
  }

  protected abortWebSocketDispatches(ws: WebSocket): void {
    const state = this.wsDispatchAbortStates.get(ws)
    if (!state) {
      return
    }
    this.wsDispatchAbortStates.delete(ws)
    ws.off('close', state.abortOnClose)
    ws.off('error', state.abortOnClose)
    for (const controller of state.controllers) {
      controller.abort()
    }
    state.controllers.clear()
  }

  protected initializePairingIdentity(): PairingIdentityInitialization {
    let deviceRegistry: DeviceRegistry
    try {
      deviceRegistry = new DeviceRegistry(this.userDataPath)
    } catch (error) {
      console.error('[runtime] Failed to initialize pairing registry:', error)
      return {
        ok: false,
        failure: pairingUnavailable(
          'device_registry_unavailable',
          DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE
        )
      }
    }
    let e2eeKeypair: E2EEKeypair
    try {
      e2eeKeypair = loadOrCreateE2EEKeypair(this.userDataPath)
    } catch (error) {
      console.error('[runtime] Failed to initialize E2EE identity:', error)
      return {
        ok: false,
        failure: pairingUnavailable('e2ee_key_unavailable', E2EE_KEY_UNAVAILABLE_GUIDANCE)
      }
    }
    return { ok: true, deviceRegistry, e2eeKeypair }
  }
}
