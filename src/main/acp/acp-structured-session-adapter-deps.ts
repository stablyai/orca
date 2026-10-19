import type { StructuredAgentSessionChildWorkProducer } from '../native-chat/agent-session-wire/structured-agent-session-subagent-rows'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type { AgentJournalDispatchRejection } from '../../shared/agent-session-failure-words'
import type { JournalLoad } from '../native-chat/agent-session-journal/journal-open'
import type { AcpLaunchSpec } from './acp-launch-specs'
import type { ConnectAcpAgent } from './acp-structured-connection'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import type { AgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'

/** How long a Stop, counted from its cancel, lets the agent end its turn before the child goes. */
export const ACP_STOP_GRACE_MS = 4_000
/** How long a model or effort pick waits for the agent's answer, as Claude's and Codex's do. */
export const ACP_OPTION_WRITE_TIMEOUT_MS = 30_000

export type AcpStructuredSessionAdapterDeps = {
  spec: AcpLaunchSpec
  /** The child to spawn, sealed with the reservation's token. */
  resolveLaunch: (input: {
    identity: AgentSessionJournalIdentity
    spawnToken: string
    /** The mode the host decided this start runs with; absent asks. */
    permissionMode?: AgentChatPermissionMode
  }) => Promise<AcpStructuredLaunch>
  /** The same launch for a read that starts no child (restart recovery): the agent's env, unsealed. */
  readLaunch: (identity: AgentSessionJournalIdentity) => Promise<AcpStructuredLaunch>
  /** Current host arguments before protocol-specific filtering; copies open through the CLI. */
  resolveLaunchArgs?: () => Promise<string[]> | string[]
  /** The chat's journal as it stands, read without opening it; null when it has none. */
  readJournal?: (sessionId: string) => JournalLoad | null
  /** Orca's data folder on this host, under its instance lock. */
  dataDirectory: string
  /** Starts the agent's process and owns its protocol: `createAcpAgentConnection` in production. */
  connect: ConnectAcpAgent
  readProcessStartTime?: (pid: number) => Promise<number | null>
  /** Every exit, expected or not: the host ends that child's record. */
  onEvent?: (event: StructuredAgentSessionLifecycleEvent) => void
  /** `producer`: the reporting child's own sink, which writes what the report changes. */
  onChildWorkEvidence?: (
    sessionId: string,
    evidence: AgentChildWorkEvidence[],
    producer?: StructuredAgentSessionChildWorkProducer
  ) => void
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
