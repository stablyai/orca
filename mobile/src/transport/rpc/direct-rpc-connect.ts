import { DirectRpcClient } from './direct-rpc-client'
import type { ConnectionLogSink } from '../../diagnostics/connection/connection-log-types'
import type { ConnectionState } from '../connection/connection-state'
import type { RpcClient } from './rpc-client-contract'

export type ConnectOptions = {
  onStateChange?: (state: ConnectionState) => void
  onLog?: ConnectionLogSink
  /** The paired host, so the capabilities its loaded page declares are advertised too. */
  hostId?: string
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
