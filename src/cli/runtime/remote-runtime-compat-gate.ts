import type { PairedRuntimeConnection } from '../../shared/remote-runtime/pairing/paired-runtime-connection'
import { describeRuntimeCompatBlock, evaluateRuntimeCompat } from '../../shared/protocol-compat'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../shared/protocol-version'
import type {
  RuntimeRequestSelection,
  RuntimeOrchestrationEnvelope
} from '../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { recordRuntimeEnvironmentUsage } from '../../shared/remote-runtime/host-store/runtime-environment-usage-record'
import { prepareRecipeVmEnvironmentCall } from './recipe-vm-wake-gate'
import { resolveRemoteConnection } from './runtime-remote-pairing'
import { RuntimeClientError, RuntimeRpcFailureError, type RuntimeRpcResponse } from './types'
import type {
  sendWebSocketRequest,
  sendWebSocketRequestWithStatusPreflight
} from './websocket-transport'

type WebSocketTransport = {
  sendWebSocketRequest: typeof sendWebSocketRequest
  sendWebSocketRequestWithStatusPreflight: typeof sendWebSocketRequestWithStatusPreflight
}

export class RemoteRuntimeCompatGate {
  private checked = false
  private connectionAfterWake: PairedRuntimeConnection | null = null

  constructor(
    private readonly userDataPath: string,
    private readonly environmentSelector: string | null
  ) {}

  async send<TResult>(args: {
    transport: WebSocketTransport
    connection: PairedRuntimeConnection
    method: string
    params: unknown
    timeoutMs: number
    envelope?: RuntimeOrchestrationEnvelope
    requestSelection?: RuntimeRequestSelection
  }): Promise<RuntimeRpcResponse<TResult>> {
    // A recipe VM's server is gone while the VM sleeps; only the desktop that owns it can wake it.
    if (
      this.environmentSelector &&
      (await prepareRecipeVmEnvironmentCall(
        this.userDataPath,
        this.environmentSelector,
        args.method
      )) === 'reload'
    ) {
      // A resume re-pairs the VM's server: this and later requests use the saved pairing.
      this.connectionAfterWake = await resolveRemoteConnection(
        this.userDataPath,
        null,
        this.environmentSelector
      )
    }
    const connection = this.connectionAfterWake ?? args.connection
    if (!args.requestSelection && (this.checked || args.method === 'status.get')) {
      return args.transport.sendWebSocketRequest<TResult>(
        connection,
        args.method,
        args.params,
        args.timeoutMs,
        args.envelope
      )
    }
    return args.transport.sendWebSocketRequestWithStatusPreflight<TResult>(
      connection,
      args.method,
      args.params,
      args.timeoutMs,
      (response) => {
        if (response.ok === false) {
          throw new RuntimeRpcFailureError(response)
        }
        this.noteVerifiedStatus(response.result)
        if (this.environmentSelector) {
          recordRuntimeEnvironmentUsage(this.userDataPath, this.environmentSelector, {
            runtimeId: response._meta.runtimeId
          })
        }
      },
      args.envelope,
      args.requestSelection
    )
  }

  noteVerifiedStatus(status: RuntimeStatus): void {
    const verdict = evaluateRuntimeCompat({
      clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
      serverProtocolVersion: status.runtimeProtocolVersion ?? status.protocolVersion,
      serverMinCompatibleClientProtocolVersion:
        status.minCompatibleRuntimeClientVersion ?? status.minCompatibleMobileVersion
    })
    if (verdict.kind === 'blocked') {
      throw new RuntimeClientError('incompatible_runtime', describeRuntimeCompatBlock(verdict))
    }
    this.checked = true
  }
}
