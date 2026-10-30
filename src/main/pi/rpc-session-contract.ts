import type {
  JsonlRpcAgentConnection,
  JsonlRpcAgentConnectionOptions
} from '../jsonl-rpc/agent-connection'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type {
  StructuredAgentSessionLifecycleEvent,
  AgentSessionDispatchOutcome
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { PiHistoryCaptureDeps } from './rpc-history-capture'

export type PiRpcConnection = Pick<
  JsonlRpcAgentConnection,
  | 'request'
  | 'send'
  | 'close'
  | 'pauseReading'
  | 'resumeReading'
  | 'pid'
  | 'closed'
  | 'rootVerdict'
  | 'processless'
  | 'spawnAbsence'
  | 'lastCloseResult'
  | 'onExit'
>
export type PiRpcSessionDeps = PiHistoryCaptureDeps & {
  openConnection?: (
    launch: ProviderProcessLaunch,
    handlers: JsonlRpcAgentConnectionOptions
  ) => PiRpcConnection
  onLifecycle: (event: StructuredAgentSessionLifecycleEvent) => void
  onSettled: (input: {
    sessionId: string
    clientMessageId: string
    fence: number
    outcome: AgentSessionDispatchOutcome
  }) => void
  logger: StructuredAgentSessionLogger
}
