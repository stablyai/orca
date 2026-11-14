import type { AgentSessionAccountKind } from '../../../shared/agent-session/agent-session-availability'
import type { AgentSessionContextUsage } from '../../../shared/agent-session/agent-session-context-usage'
import type { AgentSessionUsageLimit } from '../../../shared/agent-session/failures/agent-session-usage-limit'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionPromptResponse } from '../../../shared/agent-session/agent-session-question-answer'
import type {
  NativeChatBackgroundTaskBlock,
  NativeChatSubagentState
} from '../../../shared/native-chat/native-chat-types'
import type { ProviderTimelineRequestBody } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpAgentError } from '../transport/acp-errors'
import type { AgentSessionOptionChoice } from '../../../shared/agent-session/agent-session-wire'
import type {
  AvailableCommand,
  ClientCapabilities,
  InitializeResponse,
  ModelInfo,
  SessionNotification,
  ToolCallUpdate
} from '../generated/acp-protocol.generated'

export const pendingAcpResolution = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const

export type AcpRequestPresentation = {
  body: ProviderTimelineRequestBody
  reply(response: AgentSessionPromptResponse | null): unknown
  /** A URL request the agent may later report finished with `elicitation/complete`. */
  elicitationId?: string
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
  /** The provider started this subagent again; reopens it after an ending. */
  restart?: true
  /** The subagent that spawned this one; absent for the main agent's. */
  ownerId?: string
}

/** A subagent's own report, relayed on its root session; it never opens or ends the root's turns. */
export type AcpChildSessionReport = {
  rootSessionId: string
  agentId: string
  /** Set for a child of another child. */
  parentAgentId?: string
  label?: string
  state?: NativeChatSubagentState
  /** The child began an execution. */
  started?: true
  update?: SessionNotification
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
      failure?: Pick<AcpTurnEnding, 'stopReason' | 'failureDetail' | 'usageLimit'>
      usage?: AgentSessionContextUsage
      backgroundTasks?: AcpBackgroundTaskUpdate[]
      subagents?: AcpSubagentUpdate[]
      child?: AcpChildSessionReport
    }

/** Hook denial completes the turn rather than recording a user Stop. */
export type AcpHookBlock = { reason?: string }

export type AcpTurnEnding = {
  stopReason: string
  at: number
  durationMs?: number
  failureDetail?: string
  notSignedIn?: boolean
  /** The agent had no model for the prompt; why (selection or sign-in) is unknown. */
  modelNotSelected?: boolean
  usageLimit?: AgentSessionUsageLimit
  /** Structured error data shows the model provider failed; runtime only. */
  providerFailure?: boolean
  hookBlock?: AcpHookBlock
}

/** Undefined means a normally ended /compact succeeded. */
export type AcpCompactionReply = { outcome: 'skipped' | 'failed'; detail: string }

/** What the agent's own model command reported: the model it now runs, or why it refused. */
export type AcpModelCommandReply =
  | { applied: string }
  | { refused: 'notSignedIn' | 'modelUnavailable'; detail: string }

/** Hooks interpret extensions; lifecycle and row identity stay shared. */
export type AcpDialect = {
  /** Effort replaces part of the native composite model selection. */
  effortChangesModel?: true
  subagentStop?: {
    /** Probe without a target to establish support without cancelling a child. */
    probe: { method: string; params: unknown }
    recognizesProbeError(error: AcpAgentError): boolean
    request(sessionId: string, id: string): { method: string; params: unknown }
    response(value: unknown, id: string): { cancelled: boolean; state?: NativeChatSubagentState }
  }
  /** Subagents are child sessions that `session/close` interrupts; a user's Stop also ends them. */
  childSessionStop?: { supported(initialized: InitializeResponse): boolean }
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
  /** Completion of an independent text task, apart from interactive turn projection. */
  textTaskCompletion?(
    method: string,
    params: unknown
  ): { sessionId: string; promptId: string; stopReason: string } | undefined
  contextWindow?(models: unknown): number | undefined
  modelEfforts?(model: ModelInfo): {
    efforts: AgentSessionOptionChoice[]
    defaultEffort?: string
    declaredDefaultEffort?: string | null
  }
  /** Native thinking choices remain valid across models; the agent clamps unsupported levels. */
  clampsUnlistedEffort?: true
  /** Opt-in because advertising forms changes agent behaviour; requests use the generic handlers. */
  clientCapabilities?: Pick<ClientCapabilities, 'elicitation' | '_meta'>
  /** Claimed permission requests are never auto-approved. */
  request?(method: string, params: unknown): AcpRequestPresentation | undefined
  /** The agent's own notification that a URL request it raised finished, carrying `elicitationId`. */
  elicitationComplete?(method: string): boolean
  settleRequest?(method: string, params: unknown): AcpRequestSettlement | undefined
  promptErrorDetail?(error: AcpAgentError): string | undefined
  promptFailure?(
    error: AcpAgentError,
    at: number
  ): Pick<AcpTurnEnding, 'stopReason' | 'usageLimit' | 'providerFailure'> | undefined
  authenticationRequired?(error: AcpAgentError): boolean
  /** The agent dropped this session; only a new child can reopen it. */
  sessionLost?(error: AcpAgentError, sessionId: string): boolean
  hookBlock?(meta: unknown): AcpHookBlock | undefined
  failedTurnText?(stopReason: string): string
  compactionReply?(text: string): AcpCompactionReply | undefined
  /** The agent's own model command resolves selections its model option cannot name. */
  modelCommand?: {
    /** Only the model option's own "unknown model" refusal sends the value to the command. */
    refusedByOption(error: AcpAgentError): boolean
    /** The prompt failed because no model resolved, not because the agent is signed out. */
    noModel(error: AcpAgentError): boolean
    /** The first release whose command resolves what its option refuses; older ones take ids only. */
    resolvesSelectorsFrom: string
    text(value: string): string
    reply(text: string): AcpModelCommandReply
  }
  /** The agent reads a mentioned file only from a resource link, not from `@path` text. */
  linksFileMentions?: true
  /** Hide these commands and reject command-only prompts before dispatch. */
  withheldCommands?: readonly string[]
  /** Which sign-in a not-signed-in chat needs; absent is the agent's usual one. */
  signInAccount?: AgentSessionAccountKind
  /** Which session rows are the agent's own built-ins, as this process's initialize response proves. */
  builtinCommands?(initialized: InitializeResponse): (command: AvailableCommand) => boolean
}

export type AcpChildStops = { subagents: boolean; backgroundTasks: boolean }

export const GENERIC_ACP_DIALECT: AcpDialect = {}
