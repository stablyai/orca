import type {
  CanUseTool,
  HookCallback,
  OnUserDialog,
  Options as ClaudeAgentSdkOptions
} from '@anthropic-ai/claude-agent-sdk'

type ControlRequest = { request_id: string; request: Record<string, unknown> }

/** Requests the SDK leaves for the machine serving the session's remote tools. */
const SILENT_SUBTYPES = new Set([
  'remote_tool_call',
  'remote_plumbing_call',
  'remote_tools_probe',
  'remote_tools_reannounce'
])

/** No answer at all, as the SDK does when a handler declines to settle a request. */
const SILENT = Symbol('silent')

export type ClaudeKeptAgentHandlers = {
  canUseTool?: CanUseTool
  onUserDialog?: OnUserDialog
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function defined(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined))
}

/**
 * The callback ids the SDK gave the agent at initialize: `hook_<n>` in the options' own order. The
 * agent was started by this build with the same launch options, so the order matches.
 */
export function claudeHookCallbacksById(
  hooks: ClaudeAgentSdkOptions['hooks'] | undefined
): Map<string, HookCallback> {
  const byId = new Map<string, HookCallback>()
  let next = 0
  for (const matchers of Object.values(hooks ?? {})) {
    for (const matcher of matchers ?? []) {
      for (const callback of matcher.hooks) {
        byId.set(`hook_${next++}`, callback)
      }
    }
  }
  return byId
}

/** The SDK's own reading of a `can_use_tool` request into canUseTool's options. */
function canUseToolOptions(
  message: ControlRequest,
  signal: AbortSignal
): Parameters<CanUseTool>[2] {
  const { request } = message
  const mcpServer = isRecord(request.mcp_server) ? request.mcp_server : null
  const folder = isRecord(request.computer_folder) ? request.computer_folder : null
  const rule = isRecord(request.matched_ask_rule) ? request.matched_ask_rule : null
  return {
    signal,
    toolUseID: String(request.tool_use_id ?? ''),
    requestId: message.request_id,
    ...defined({
      suggestions: Array.isArray(request.permission_suggestions)
        ? request.permission_suggestions
        : undefined,
      blockedPath: optionalString(request.blocked_path),
      mcpServer:
        mcpServer && typeof mcpServer.name === 'string'
          ? { name: mcpServer.name, source: String(mcpServer.source ?? '') }
          : undefined,
      decisionReason: optionalString(request.decision_reason),
      decisionReasonType: optionalString(request.decision_reason_type),
      decisionReasonCode: optionalString(request.decision_reason_code),
      serverPolicyAskOnly: optionalBoolean(request.server_policy_ask_only),
      title: optionalString(request.title),
      displayName: optionalString(request.display_name),
      description: optionalString(request.description),
      defaultToNo: optionalBoolean(request.default_to_no),
      suppressAlwaysAllowRule: optionalBoolean(request.suppress_always_allow_rule),
      agentID: optionalString(request.agent_id),
      plugin: optionalString(request.plugin),
      requiresUserInteraction: optionalBoolean(request.requires_user_interaction),
      serverPrompt: optionalString(request.server_prompt),
      computerFolder:
        folder && typeof folder.path === 'string' && typeof folder.computer_name === 'string'
          ? { path: folder.path, computer_name: folder.computer_name }
          : undefined,
      matchedAskRule:
        rule && typeof rule.source === 'string' && typeof rule.tool_name === 'string'
          ? {
              source: rule.source,
              toolName: rule.tool_name,
              ...(rule.rule_content === undefined ? {} : { ruleContent: rule.rule_content })
            }
          : undefined
    })
  } as Parameters<CanUseTool>[2]
}

/**
 * Answers the agent's `control_request`s for a chat whose agent kept running under the terminal
 * daemon: approvals, hook callbacks and dialogs go to the chat's own handlers, exactly as the SDK
 * would route them; the answer goes back over the relay as a `control_response`.
 */
export class ClaudeKeptAgentResponder {
  private readonly cancels = new Map<string, AbortController>()
  private readonly hooks: Map<string, HookCallback>

  constructor(
    private readonly handlers: ClaudeKeptAgentHandlers,
    hooks: ClaudeAgentSdkOptions['hooks'] | undefined,
    private readonly write: (line: string) => void
  ) {
    this.hooks = claudeHookCallbacksById(hooks)
  }

  /** Every `control_request` / `control_cancel_request` line; false for any other message. */
  observe(message: Record<string, unknown>): boolean {
    if (message.type === 'control_cancel_request') {
      const id = optionalString(message.request_id)
      if (id) {
        this.cancels.get(id)?.abort()
        this.cancels.delete(id)
      }
      return true
    }
    if (
      message.type !== 'control_request' ||
      typeof message.request_id !== 'string' ||
      !isRecord(message.request)
    ) {
      return false
    }
    const request = { request_id: message.request_id, request: message.request }
    // A held request re-sent after a reattach is already being answered.
    if (!this.cancels.has(request.request_id)) {
      void this.answer(request)
    }
    return true
  }

  /** The agent ended: nothing it asked can be answered any more. */
  dispose(): void {
    for (const controller of this.cancels.values()) {
      controller.abort()
    }
    this.cancels.clear()
  }

  private async answer(message: ControlRequest): Promise<void> {
    const controller = new AbortController()
    this.cancels.set(message.request_id, controller)
    let line: string | null
    try {
      const response = await this.process(message, controller.signal)
      line =
        response === SILENT
          ? null
          : JSON.stringify({
              type: 'control_response',
              response: { subtype: 'success', request_id: message.request_id, response }
            })
    } catch (error) {
      line = JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: message.request_id,
          error: error instanceof Error ? error.message : String(error)
        }
      })
    }
    if (this.cancels.get(message.request_id) !== controller) {
      return
    }
    this.cancels.delete(message.request_id)
    if (line !== null && !controller.signal.aborted) {
      this.write(`${line}\n`)
    }
  }

  private async process(message: ControlRequest, signal: AbortSignal): Promise<unknown> {
    const { request } = message
    const subtype = request.subtype
    if (typeof subtype === 'string' && SILENT_SUBTYPES.has(subtype)) {
      return SILENT
    }
    if (subtype === 'can_use_tool') {
      if (!this.handlers.canUseTool) {
        throw new Error('canUseTool callback is not provided.')
      }
      const input = isRecord(request.input) ? request.input : {}
      const result = await this.handlers.canUseTool(
        String(request.tool_name ?? ''),
        input,
        canUseToolOptions(message, signal)
      )
      return result === null ? SILENT : { ...result, toolUseID: request.tool_use_id }
    }
    if (subtype === 'hook_callback') {
      const callbackId = String(request.callback_id ?? '')
      const callback = this.hooks.get(callbackId)
      if (!callback) {
        throw new Error(`No hook callback found for ID: ${callbackId}`)
      }
      return callback(
        request.input as Parameters<HookCallback>[0],
        optionalString(request.tool_use_id),
        { signal }
      )
    }
    if (subtype === 'request_user_dialog') {
      if (!this.handlers.onUserDialog) {
        return SILENT
      }
      const result = await this.handlers.onUserDialog(
        {
          dialogKind: request.dialog_kind,
          payload: request.payload,
          toolUseID: request.tool_use_id
        } as Parameters<OnUserDialog>[0],
        { signal, requestId: message.request_id }
      )
      return result === null ? SILENT : result
    }
    if (subtype === 'elicitation') {
      return { action: 'decline' }
    }
    throw new Error(`Unsupported control request subtype: ${String(subtype)}`)
  }
}
