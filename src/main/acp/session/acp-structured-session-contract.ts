import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import type { AgentChatPermissionMode } from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { AcpChildStops } from '../acp-dialects/acp-dialect'
import type { AcpStructuredConnection } from '../process/acp-structured-connection'
import type { AcpStructuredLane } from '../journal/acp-structured-lane'
import type { AcpStructuredOptions } from '../options/acp-structured-options'
import type { AcpStructuredPrompts } from '../requests/acp-structured-prompts'
import type { AcpStructuredTurns } from '../turns/acp-structured-turns'
import type { StructuredAgentSessionEventSink } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { StructuredAgentSessionProviderOpenResult } from '../../native-chat/agent-session-wire/startup/structured-agent-session-provider-open-contract'

export type AcpStructuredSession = {
  events?: StructuredAgentSessionEventSink
  sessionId: string
  fence: number
  acquisitionGeneration: string
  spec: AcpLaunchSpec
  /** The session's folder on the agent's host. */
  cwd: string
  /** Session modes this launch reports as Orca's permission modes. */
  permissionModes: Readonly<Partial<Record<AgentChatPermissionMode, string>>> | undefined
  childStops?: AcpChildStops
  connection: AcpStructuredConnection
  lane: AcpStructuredLane
  prompts: AcpStructuredPrompts
  options: AcpStructuredOptions
  turns: AcpStructuredTurns
  closeRequested: boolean
  /** Why Orca stopped this agent after its own failure (stream loss, a refused journal write). */
  failureClose: string | null
  /** Null while provider events can still reach the journal. */
  journalClosed: string | null
  historyCatchUp?: AbortController
  /** Exit was proven and reported to the host. */
  ended: boolean
  exitObservedAt: number | null
  unbindReadingControl?: () => void
  dispose: () => void
  open: (signal: AbortSignal) => Promise<StructuredAgentSessionProviderOpenResult>
}
