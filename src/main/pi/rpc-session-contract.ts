import type {
  JsonlRpcAgentConnection,
  JsonlRpcAgentConnectionOptions
} from '../jsonl-rpc/agent-connection'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import type { JsonlRpcTimelineLane } from '../jsonl-rpc/timeline-lane'
import type { PiRpcDialogCallbacks } from './rpc-dialog-callbacks'
import type { piRpcProviderLink, PiRpcResolvedLaunch } from './rpc-launch-resolution'
import type { PiRpcSession } from './rpc-session'
import type { buildPiRpcLaunch } from './rpc-launch'
import type { PiHistoryCaptureDeps } from './rpc-history-capture'
import type {
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionLifecycleEvent,
  AgentSessionDispatchOutcome
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import type { StructuredAgentSessionChildWorkProducer } from '../native-chat/agent-session-wire/structured-agent-session-subagent-rows'
import type { AgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'

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
> & { thinkingLevels?: () => Promise<string[]> }
export type PiRpcSessionDeps = PiHistoryCaptureDeps & {
  onChildWorkEvidence?: (
    sessionId: string,
    evidence: AgentChildWorkEvidence[],
    producer?: StructuredAgentSessionChildWorkProducer
  ) => void
  dialect?: {
    agent: string
    correlatedPrompts?: boolean
    idleAbort?: boolean
    providerLink: typeof piRpcProviderLink
    prepare?: (connection: PiRpcConnection) => Promise<void>
    dispatchOptions?: {
      keys: readonly (keyof AgentSessionExecutionOptions)[]
      alwaysWrite?: readonly (keyof AgentSessionExecutionOptions)[]
      write: (
        session: PiRpcSession,
        key: keyof AgentSessionExecutionOptions,
        value: string,
        signal?: AbortSignal
      ) => Promise<unknown>
    }
    dialogs?: (
      lane: JsonlRpcTimelineLane,
      send: (frame: JsonlRpcRecord) => Promise<void>,
      fail: (error: Error) => void
    ) => Pick<PiRpcDialogCallbacks, 'receive' | 'respond' | 'cancelAll'>
    receive?: (frame: JsonlRpcRecord, session: PiRpcSession) => boolean
  }
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

export type PiRpcSessionAdapterDeps = PiRpcSessionDeps & {
  buildLaunch?: typeof buildPiRpcLaunch
  resolveLaunch: (input: {
    [K in 'identity' | 'spawnToken']: StructuredAgentSessionAcquireInput[K]
  }) => Promise<PiRpcResolvedLaunch>
  readProcessStartTime?: (pid: number) => Promise<number | null>
}
