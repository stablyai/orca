import { randomUUID } from 'node:crypto'
import type { ZcodeAppServerConnection } from '../../app-server/zcode-app-server-connection-types'
import type { AgentChatPermissionChoice } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { AgentJournalDispatchRejection } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { StructuredAgentSessionLifecycleEvent } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { StructuredLaunchRequest } from '../../../runtime/agent-session/launch/structured-agent-launch-composition'
import type { ZcodeChatCredentials } from '../credentials/zcode-chat-credentials'

// How a durable session record becomes a zcode app-server process launch.

export type ZcodeLaunchModel = {
  providerId: string
  modelId: string
  reasoningLevel?: string
}

export type ZcodeStructuredLaunch = {
  command: string
  prefixArgs: string[]
  args: string[]
  /** The chat's working directory (composition fills it from the launch directory). */
  cwd: string
  /** The sealed child environment (composition fills it from the agent environment). */
  env: Record<string, string>
  /** Orca permission choice; 'own' launches with zcode's own saved mode. */
  permissionMode?: AgentChatPermissionChoice
  /** Open on the chosen model to avoid a first-turn switch. */
  model: ZcodeLaunchModel | null
  /** The provider session a resume continues; null creates a new session. */
  resumeSessionId: string | null
  /** Set when that resume continues a rewind fork, so the open reports a forked chain link. */
  forkedFromKey?: string
  /** Provider tables and app-version env the spawn must carry (agent env additions). */
  providerEnv: Record<string, string>
  /** The desktop-bundle runtime to retry on when this CLI refuses the account push. */
  fallbackRuntime: {
    command: string
    args: string[]
    env: Record<string, string>
  } | null
}

/** One zcode app-server frame bound to the Orca session it belongs to. */
export type ZcodeStructuredSessionEvent =
  | {
      type: 'notification'
      sessionId: string
      method: string
      params: unknown
    }
  | { type: 'server-request'; sessionId: string; method: string; params: unknown }
  | { type: 'provider-frame'; sessionId: string; kind: string; payload: unknown }
  | StructuredAgentSessionLifecycleEvent
  | { type: 'ended'; sessionId: string; reason: string }

export type ZcodeStructuredSessionAdapterDeps = {
  resolveLaunch: (input: StructuredLaunchRequest) => Promise<ZcodeStructuredLaunch>
  onEvent?: (event: ZcodeStructuredSessionEvent) => void
  logger?: StructuredAgentSessionLogger
  /** The plan credentials runtime-header asks are answered with; null declines them. */
  resolveChatCredentials: () => ZcodeChatCredentials | null
  readProcessStartTime?: (pid: number) => Promise<number | null>
  mintLinkId?: () => string
  mintAcquisitionGeneration?: () => string
  now?: () => number
  requestTimeoutMs?: number
  /** The provider's exact receipt or explicit refusal for a send admitted earlier. */
  onDispatchSettledLate?: (
    settlement: {
      sessionId: string
      clientMessageId: string
    } & (
      | { providerIdentity: AgentJournalItemIdentity }
      | { state: 'unknown'; reason: string }
      | ({ state: 'rejected' } & AgentJournalDispatchRejection)
    )
  ) => void | Promise<void>
}

export type ZcodeSession = {
  events?: StructuredAgentSessionEventSink
  connection: ZcodeAppServerConnection
  ended: boolean
  exitObservedAt?: number
  fence: number
  acquisitionGeneration: string
  /** zcode's own session id (`sess_...`); also the provider handle's nativeId. */
  providerSessionId: string
  /** The command/env this child launched with; a push retry respawns with the fallback. */
  launch: ZcodeStructuredLaunch
}

export function mintZcodeAcquisitionGeneration(deps: ZcodeStructuredSessionAdapterDeps): string {
  return deps.mintAcquisitionGeneration?.() ?? randomUUID()
}

export function requireLiveZcodeSession(
  sessions: Map<string, ZcodeSession>,
  sessionId: string
): ZcodeSession {
  const session = sessions.get(sessionId)
  if (!session || session.ended) {
    throw new Error(`no live zcode app-server for session ${sessionId}`)
  }
  return session
}
