import type { AgentSessionContextUsage } from '../../../shared/agent-session-context-usage'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionPromptResponse } from '../../../shared/agent-session-question-answer'
import type { NativeChatBackgroundTaskBlock } from '../../../shared/native-chat-types'
import type { ProviderTimelineRequestBody } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpAgentError } from '../acp-errors'
import type { PermissionOption, ToolCallUpdate } from '../generated/acp-protocol.generated'

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
    }

/** Hooks interpret extensions; lifecycle and row identity stay shared. */
export type AcpDialect = {
  injectedPromptIdentity?: true
  /** A tool update in the shared shape (`rawOutput.stdout`, `rawOutput.exitCode`), read first. */
  normalizeToolUpdate?(update: ToolCallUpdate): ToolCallUpdate
  /** The words for a permission option whose own name misstates what it grants. */
  permissionOptionLabel?(option: PermissionOption): string | undefined
  toolName?(update: ToolCallUpdate): string | undefined
  toolBackgroundTasks?(
    update: ToolCallUpdate,
    tool: AgentJournalToolCallItem
  ): AcpBackgroundTaskUpdate[]
  notification?(method: string, params: unknown, at: number): AcpDialectNotification | undefined
  contextWindow?(models: unknown): number | undefined
  request?(method: string, params: unknown): AcpRequestPresentation | undefined
  /** Requests answered at once instead of shown to the person. */
  settleRequest?(method: string, params: unknown): AcpRequestSettlement | undefined
  /** The provider's words in a `session/prompt` error answer, when its message is generic. */
  promptErrorDetail?(error: AcpAgentError): string | undefined
  /** The row for a failed turn the provider gave no words for. */
  failedTurnText?(stopReason: string): string
}

export const GENERIC_ACP_DIALECT: AcpDialect = {}
