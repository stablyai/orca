import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type { AgentJournalDispatchRejection } from '../../shared/agent-session-failure-words'
import type { AcpLaunchSpec } from './acp-launch-specs'
import type { ConnectAcpAgent } from './acp-structured-connection'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'

/** How long a Stop, counted from its cancel, lets the agent end its turn before the child goes. */
export const ACP_STOP_GRACE_MS = 4_000
/** How long a model or effort pick waits for the agent's answer, as Claude's and Codex's do. */
export const ACP_OPTION_WRITE_TIMEOUT_MS = 30_000

export type AcpStructuredSessionAdapterDeps = {
  spec: AcpLaunchSpec
  resolveLaunch: (input: { identity: AgentSessionJournalIdentity }) => Promise<AcpStructuredLaunch>
  /** Starts the agent's process and owns its protocol: `createAcpAgentConnection` in production. */
  connect: ConnectAcpAgent
  readProcessStartTime?: (pid: number) => Promise<number | null>
  /** Every exit, expected or not: the host ends that child's record. */
  onEvent?: (event: StructuredAgentSessionLifecycleEvent) => void
  /** A send this adapter admitted, settled once the agent answered for it. */
  onDispatchSettledLate?: (
    settlement: { sessionId: string; clientMessageId: string } & (
      | { providerIdentity: AgentJournalItemIdentity }
      | ({ state: 'rejected' } & AgentJournalDispatchRejection)
      | { state: 'unknown'; reason: string }
    )
  ) => void
  logger?: StructuredAgentSessionLogger
  now?: () => number
  mintGeneration?: () => string
  mintLinkId?: () => string
  /** Bounds a Stop's wait for the agent to end its turn; past it the child is closed. */
  stopGraceMs?: number
  /** Bounds a pick's wait for the agent's answer; past it the pick fails. */
  optionWriteTimeoutMs?: number
  isWindowsProcessStartTimeAvailable?: () => boolean
}
