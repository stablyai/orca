import { DirectRpcClient } from './direct-rpc-client'
import type { ConnectionLogSink, ConnectionState, RpcClient } from './types'

export type { SendRequestOptions } from './unvalidated-rpc-request-port'

export type { RpcClient } from './types'

export type ConnectOptions = {
  onStateChange?: (state: ConnectionState) => void
  onLog?: ConnectionLogSink
}

export function connect(
  endpoint: string,
  deviceToken: string,
  serverPublicKeyB64: string,
  optionsOrLegacy?: ConnectOptions | ((state: ConnectionState) => void)
): RpcClient {
  const options: ConnectOptions =
    typeof optionsOrLegacy === 'function'
      ? { onStateChange: optionsOrLegacy }
      : (optionsOrLegacy ?? {})
  return new DirectRpcClient(endpoint, deviceToken, serverPublicKeyB64, options)
}
