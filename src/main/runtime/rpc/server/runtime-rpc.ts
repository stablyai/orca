// Why: the single security boundary for the bundled CLI — auth-token enforcement, metadata publication, transport orchestration.
import { RuntimeRpcShutdown } from './runtime-rpc-shutdown'
import type { OrcaRuntimeRpcServerOptions } from './runtime-rpc-pairing-types'

export class OrcaRuntimeRpcServer extends RuntimeRpcShutdown {
  constructor(options: OrcaRuntimeRpcServerOptions) {
    super(options)
  }
}
