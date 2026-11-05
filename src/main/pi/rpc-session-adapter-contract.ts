import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { PiRpcResolvedLaunch } from './rpc-launch-resolution'
import type { PiRpcSessionDeps } from './rpc-session'

export type PiRpcSessionAdapterDeps = PiRpcSessionDeps & {
  resolveLaunch: (input: {
    [K in 'identity' | 'spawnToken']: StructuredAgentSessionAcquireInput[K]
  }) => Promise<PiRpcResolvedLaunch>
  readProcessStartTime?: (pid: number) => Promise<number | null>
}
