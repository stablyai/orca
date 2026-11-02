import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
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
import { markEnvironmentUsed } from './environments'
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

  constructor(
    private readonly userDataPath: string,
    private readonly environmentSelector: string | null
  ) {}

  send<TResult>(args: {
    transport: WebSocketTransport
    connection: PairedRuntimeConnection
    method: string
    params: unknown
    timeoutMs: number
    envelope?: RuntimeOrchestrationEnvelope
    requestSelection?: RuntimeRequestSelection
  }): Promise<RuntimeRpcResponse<TResult>> {
    if (!args.requestSelection && (this.checked || args.method === 'status.get')) {
      return args.transport.sendWebSocketRequest<TResult>(
        args.connection,
        args.method,
        args.params,
        args.timeoutMs,
        args.envelope
      )
    }
    return args.transport.sendWebSocketRequestWithStatusPreflight<TResult>(
      args.connection,
      args.method,
      args.params,
      args.timeoutMs,
      (response) => {
        if (response.ok === false) {
          throw new RuntimeRpcFailureError(response)
        }
        this.noteVerifiedStatus(response.result)
        if (this.environmentSelector) {
          markEnvironmentUsed(this.userDataPath, this.environmentSelector, {
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
