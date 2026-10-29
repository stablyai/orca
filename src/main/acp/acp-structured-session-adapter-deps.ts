import type {
  AcpLaunchInvocationDeps,
  AcpStructuredLaunch
} from './acp-structured-launch-resolution'
import type { StructuredAgentSessionAtRestCommands } from '../native-chat/agent-session-wire/structured-agent-session-at-rest-commands'
import type { StructuredAgentSessionChildWorkProducer } from '../native-chat/agent-session-wire/structured-agent-session-subagent-rows'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type { AgentJournalDispatchRejection } from '../../shared/agent-session-failure-words'
import type { AcpLaunchSpec } from './acp-launch-specs'
import type { ConnectAcpAgent } from './acp-structured-connection'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import type { AgentChatPermissionChoice } from '../../shared/agent-chat-permission-mode'

// Grace begins at cancellation, before process close.
export const ACP_STOP_GRACE_MS = 4_000
export const ACP_OPTION_WRITE_TIMEOUT_MS = 30_000

export type AcpStructuredSessionAdapterDeps = {
  spec: AcpLaunchSpec
  textTaskLaunch?: AcpLaunchInvocationDeps
  atRestCommands?: StructuredAgentSessionAtRestCommands
  /** Sealed with the reservation's spawn token. */
  resolveLaunch: (input: {
    identity: AgentSessionJournalIdentity
    spawnToken: string
    /** Defaults to ask. */
    permissionMode?: AgentChatPermissionChoice
  }) => Promise<AcpStructuredLaunch>
  /** The same launch for a read that starts no child (a conversation copy): the agent's env, unsealed. */
  readLaunch: (identity: AgentSessionJournalIdentity) => Promise<AcpStructuredLaunch>
  /** Current host arguments before protocol-specific filtering; copies open through the CLI. */
  resolveLaunchArgs?: () => Promise<string[]> | string[]
  /** Protected by this host's instance lock. */
  dataDirectory: string
  connect: ConnectAcpAgent
  readProcessStartTime?: (pid: number) => Promise<number | null>
  onEvent?: (event: StructuredAgentSessionLifecycleEvent) => void
  /** `producer` is the reporting child's sink for durable changes. */
  onChildWorkEvidence?: (
    sessionId: string,
    evidence: AgentChildWorkEvidence[],
    producer?: StructuredAgentSessionChildWorkProducer
  ) => void
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
  stopGraceMs?: number
  optionWriteTimeoutMs?: number
  isWindowsProcessStartTimeAvailable?: () => boolean
}
