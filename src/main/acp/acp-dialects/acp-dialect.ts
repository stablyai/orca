import type { AgentSessionContextUsage } from '../../../shared/agent-session-context-usage'
import type { AgentSessionUsageLimit } from '../../../shared/agent-session-usage-limit'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionPromptResponse } from '../../../shared/agent-session-question-answer'
import type {
  NativeChatBackgroundTaskBlock,
  NativeChatSubagentState
} from '../../../shared/native-chat-types'
import type { ProviderTimelineRequestBody } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpAgentError } from '../acp-errors'
import type { AgentSessionOptionChoice } from '../../../shared/agent-session-wire'
import type { ModelInfo, ToolCallUpdate } from '../generated/acp-protocol.generated'

export type AcpRequestPresentation = {
  body: ProviderTimelineRequestBody
  reply(response: AgentSessionPromptResponse | null): unknown
}

export type AcpRequestSettlement = { reply: unknown; plan?: string }

export type AcpBackgroundTaskUpdate = Pick<NativeChatBackgroundTaskBlock, 'taskId' | 'state'> &
  Partial<Omit<NativeChatBackgroundTaskBlock, 'type' | 'taskId' | 'state'>> & {
    fallbackLabel?: string
    fallbackKind?: NativeChatBackgroundTaskBlock['kind']
  }

/** Omitted fields leave existing subagent state unchanged. */
export type AcpSubagentUpdate = {
  id: string
  state?: NativeChatSubagentState
  label?: string
  tokens?: number
  /** Spawning provider turn. */
  turn?: string
  result?: string
  /** Ambiguous task reports apply only to known subagents. */
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
      end?: Omit<AcpTurnEnding, 'at' | 'notSignedIn'>
      failureDetail?: string
      usage?: AgentSessionContextUsage
      backgroundTasks?: AcpBackgroundTaskUpdate[]
      subagents?: AcpSubagentUpdate[]
    }

/** Hook denial completes the turn rather than recording a user Stop. */
export type AcpHookBlock = { reason?: string }

export type AcpTurnEnding = {
  stopReason: string
  at: number
  durationMs?: number
  failureDetail?: string
  notSignedIn?: boolean
  usageLimit?: AgentSessionUsageLimit
  hookBlock?: AcpHookBlock
}

/** Undefined means a normally ended /compact succeeded. */
export type AcpCompactionReply = { outcome: 'skipped' | 'failed'; detail: string }

/** Hooks interpret extensions; lifecycle and row identity stay shared. */
export type AcpDialect = {
  subagentStop?: {
    /** Probe without a target to establish support without cancelling a child. */
    probe: { method: string; params: unknown }
    recognizesProbeError(error: AcpAgentError): boolean
    request(sessionId: string, id: string): { method: string; params: unknown }
    response(value: unknown, id: string): { cancelled: boolean; state?: NativeChatSubagentState }
  }
  backgroundTaskStop?: {
    /** Probe without a target to establish support without killing a task. */
    probe: { method: string; params: unknown }
    /** Only explicit route rejection hides Stop. */
    lacksRoute(error: AcpAgentError): boolean
    request(sessionId: string, taskId: string): { method: string; params: unknown }
    /** A missing task may still report its own ending later. */
    response(value: unknown, taskId: string): 'killed' | 'gone' | 'refused'
  }
  injectedPromptIdentity?: true
  /** Normalize before reading tools: rawOutput.stdout and rawOutput.exitCode. */
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
  modelEfforts?(model: ModelInfo): { efforts: AgentSessionOptionChoice[]; defaultEffort?: string }
  /** Claimed permission requests are never auto-approved. */
  request?(method: string, params: unknown): AcpRequestPresentation | undefined
  settleRequest?(method: string, params: unknown): AcpRequestSettlement | undefined
  promptErrorDetail?(error: AcpAgentError): string | undefined
  promptFailure?(
    error: AcpAgentError,
    at: number
  ): Pick<AcpTurnEnding, 'stopReason' | 'usageLimit'> | undefined
  authenticationRequired?(error: AcpAgentError): boolean
  hookBlock?(meta: unknown): AcpHookBlock | undefined
  failedTurnText?(stopReason: string): string
  compactionReply?(text: string): AcpCompactionReply | undefined
  /** Hide these commands and reject command-only prompts before dispatch. */
  withheldCommands?: readonly string[]
}

export type AcpChildStops = { subagents: boolean; backgroundTasks: boolean }

export const GENERIC_ACP_DIALECT: AcpDialect = {}
