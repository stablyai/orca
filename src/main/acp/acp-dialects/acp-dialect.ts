import type { AgentSessionContextUsage } from '../../../shared/agent-session-context-usage'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionPromptResponse } from '../../../shared/agent-session-question-answer'
import type {
  NativeChatBackgroundTaskBlock,
  NativeChatSubagentState
} from '../../../shared/native-chat-types'
import type { ProviderTimelineRequestBody } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpAgentError } from '../acp-errors'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'

export type AcpRequestPresentation = {
  body: ProviderTimelineRequestBody
  reply(response: AgentSessionPromptResponse | null): unknown
}

/** A request the client answers at once, asking no one: the reply, and a plan it carried for the
 *  chat's existing plan row. */
export type AcpRequestSettlement = { reply: unknown; plan?: string }

export type AcpBackgroundTaskUpdate = Pick<NativeChatBackgroundTaskBlock, 'taskId' | 'state'> &
  Partial<Omit<NativeChatBackgroundTaskBlock, 'type' | 'taskId' | 'state'>> & {
    /** Used only until a provider description is known. */
    fallbackLabel?: string
    /** Used only until a frame names the task's kind. */
    fallbackKind?: NativeChatBackgroundTaskBlock['kind']
  }

/** What the provider said about one subagent; absent fields are unchanged. */
export type AcpSubagentUpdate = {
  /** The provider's subagent id: the roster key, and where its own rows are filed. */
  id: string
  state?: NativeChatSubagentState
  label?: string
  /** Latest total tokens the provider reported for this subagent. */
  tokens?: number
  /** The provider turn that spawned it. */
  turn?: string
  /** The subagent's final reply, once it completed. */
  result?: string
  /** For a report that cannot tell a subagent from a background task: applies only to a known one. */
  knownOnly?: true
}

export type AcpDialectNotification =
  | { disposition: 'ignore' }
  | {
      disposition: 'map'
      turn?: string
      replay?: boolean
      at?: number
      started?: boolean
      end?: { stopReason: string; durationMs?: number; failureDetail?: string }
      /** The provider's own words for why `turn` failed, sent apart from its end. */
      failureDetail?: string
      usage?: AgentSessionContextUsage
      backgroundTasks?: AcpBackgroundTaskUpdate[]
      subagents?: AcpSubagentUpdate[]
    }

/** Hooks interpret extensions; lifecycle and row identity stay shared. */
export type AcpDialect = {
  subagentStop?: {
    /** Missing required target: proves the route exists without addressing any child. */
    probe: { method: string; params: unknown }
    recognizesProbeError(error: AcpAgentError): boolean
    request(sessionId: string, id: string): { method: string; params: unknown }
    response(value: unknown, id: string): { cancelled: boolean; state?: NativeChatSubagentState }
  }
  injectedPromptIdentity?: true
  /** A tool update in the shared shape (`rawOutput.stdout`, `rawOutput.exitCode`), read first. */
  normalizeToolUpdate?(update: ToolCallUpdate): ToolCallUpdate
  toolName?(update: ToolCallUpdate): string | undefined
  toolBackgroundTasks?(
    update: ToolCallUpdate,
    tool: AgentJournalToolCallItem
  ): AcpBackgroundTaskUpdate[]
  toolSubagents?(update: ToolCallUpdate, tool: AgentJournalToolCallItem): AcpSubagentUpdate[]
  /** A child-session notice supplies only its outcome; the translator owns membership and replay. */
  subagentSessionEnd?(method: string, params: unknown): 'completed' | 'stopped' | undefined
  notification?(method: string, params: unknown, at: number): AcpDialectNotification | undefined
  contextWindow?(models: unknown): number | undefined
  request?(method: string, params: unknown): AcpRequestPresentation | undefined
  /** Requests answered at once instead of shown to the person. */
  settleRequest?(method: string, params: unknown): AcpRequestSettlement | undefined
  /** The provider's words in a `session/prompt` error answer, when its message is generic. */
  promptErrorDetail?(error: AcpAgentError): string | undefined
  authenticationRequired?(error: AcpAgentError): boolean
  /** The row for a failed turn the provider gave no words for. */
  failedTurnText?(stopReason: string): string
}

export const GENERIC_ACP_DIALECT: AcpDialect = {}
