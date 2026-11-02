import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { STATUS_METHODS } from './rpc/methods/status'
import { TERMINAL_METHODS } from './rpc/methods/terminal'
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration'

export function createLongPollServer(
  options: ConstructorParameters<typeof OrcaRuntimeRpcServer>[0]
) {
  return new OrcaRuntimeRpcServer({
    ...options,
    methods: [...STATUS_METHODS, ...TERMINAL_METHODS, ...ORCHESTRATION_METHODS]
  })
}
