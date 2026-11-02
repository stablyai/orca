import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { normalizeHookEventName } from '../../shared/agent-hook-listener/provider-event-names'
import { parseAgentHookJson } from '../../shared/agent-hook-listener/request-body'
import type { z } from 'zod'
import {
  PLUGIN_HOOK_SPECS,
  type agentToolAfterHookPayloadSchema
} from '../../shared/plugins/events/plugin-hook-payloads'
import {
  notifyPluginHook,
  PluginHookDeniedError,
  pluginHookWanted,
  runPluginHook
} from '../plugins/hooks/plugin-hook-dispatch'

/** Sent by hook scripts that print Orca's answer as Claude Code's PreToolUse decision. */
export const AGENT_TOOL_DECISION_HEADER = 'x-orca-hook-decision'
export const CLAUDE_PRE_TOOL_USE_DECISION = 'claude-pre-tool-use-v1'
// Why 6 s: the script waits 8 s at most, so Orca answers (or passes) before it gives up.
const DECISION_BUDGET_MS = 6_000

const BEFORE_EVENTS = new Set([
  'pre_tool_use',
  'before_tool',
  'pre_tool',
  'pre_tool_call',
  'before_shell_execution',
  'before_mcp_execution'
])
const AFTER_EVENTS = new Set([
  'post_tool_use',
  'post_tool_use_failure',
  'after_tool',
  'post_tool',
  'post_tool_call'
])

let terminalForPaneKey: ((paneKey: string) => string | null) | null = null

/** Lets tool events name the terminal (`terminal.sendText`'s id) the agent runs in. */
export function setAgentToolHookTerminalResolver(
  resolve: ((paneKey: string) => string | null) | null
): void {
  terminalForPaneKey = resolve
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return undefined
}

function firstValue(source: Record<string, unknown>, keys: readonly string[]): unknown {
  return keys.map((key) => source[key]).find((value) => value !== undefined)
}

type AgentToolCall = {
  phase: 'before' | 'after'
  payload: z.output<typeof agentToolAfterHookPayloadSchema>
}

/** The tool call a hook post reports, across agents' field names; null for anything else. */
export function readAgentToolCall(source: AgentHookSource, body: unknown): AgentToolCall | null {
  const envelope = record(body)
  const rawPayload = envelope?.payload
  let hook: Record<string, unknown> | null = null
  try {
    hook = record(typeof rawPayload === 'string' ? parseAgentHookJson(rawPayload) : rawPayload)
  } catch {
    return null
  }
  if (!envelope || !hook) {
    return null
  }
  const eventName = normalizeHookEventName(
    firstString(hook, ['hook_event_name', 'hookEventName', 'hook_type', 'event'])
  )
  const phase = BEFORE_EVENTS.has(eventName)
    ? 'before'
    : AFTER_EVENTS.has(eventName)
      ? 'after'
      : null
  const tool = firstString(hook, ['tool_name', 'toolName', 'tool'])
  if (!phase || !tool) {
    return null
  }
  const paneKey = firstString(envelope, ['paneKey'])
  const terminalId = paneKey ? (terminalForPaneKey?.(paneKey) ?? undefined) : undefined
  const callId = firstString(hook, ['tool_use_id', 'toolUseId', 'tool_call_id', 'call_id'])
  const output = firstValue(hook, ['tool_response', 'toolResponse', 'tool_output', 'output'])
  return {
    phase,
    payload: {
      agent: source,
      workspaceId: firstString(envelope, ['worktreeId']) ?? null,
      ...(terminalId ? { terminalId } : {}),
      tool: tool.slice(0, 256),
      input: firstValue(hook, ['tool_input', 'toolInput', 'input', 'args']) ?? null,
      ...(callId ? { callId: callId.slice(0, 256) } : {}),
      ...(phase === 'after' && output !== undefined ? { output } : {})
    }
  }
}

function claudePreToolUse(fields: Record<string, unknown>): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } })
}

/**
 * Runs `agent.tool.before`/`.after` for one hook post. Returns Claude Code's PreToolUse answer
 * when the script asked for one (`deny`, or changed input that still goes through the person's
 * usual approval), else null: Orca then answers 204 and the agent carries on. Fails open.
 */
export async function answerAgentToolPluginHooks(
  source: AgentHookSource,
  body: unknown,
  headers: IncomingHttpHeaders
): Promise<string | null> {
  const wantsBefore = pluginHookWanted('agent.tool.before')
  if (!wantsBefore && !pluginHookWanted('agent.tool.after')) {
    return null
  }
  const call = readAgentToolCall(source, body)
  if (!call) {
    return null
  }
  if (call.phase === 'after') {
    notifyPluginHook('agent.tool.after', call.payload)
    return null
  }
  const decides =
    source === 'claude' && headers[AGENT_TOOL_DECISION_HEADER] === CLAUDE_PRE_TOOL_USE_DECISION
  if (!wantsBefore || !decides) {
    notifyPluginHook('agent.tool.before', call.payload)
    return null
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), DECISION_BUDGET_MS)
  })
  try {
    const decided = await Promise.race([
      runPluginHook(
        'agent.tool.before',
        PLUGIN_HOOK_SPECS['agent.tool.before'].payload,
        call.payload
      ),
      budget
    ])
    const input = record(decided?.input)
    // Claude Code takes only an object; any other change is left out.
    return input && JSON.stringify(input) !== JSON.stringify(call.payload.input)
      ? claudePreToolUse({ updatedInput: input })
      : null
  } catch (error) {
    return error instanceof PluginHookDeniedError
      ? claudePreToolUse({
          permissionDecision: 'deny',
          permissionDecisionReason: `${error.pluginKey}: ${error.reason}`
        })
      : null
  } finally {
    clearTimeout(timer)
  }
}

/** Ends a hook post: 200 with the agent's decision when a plugin made one, else 204 as before. */
export async function respondAfterAgentToolPluginHooks(
  res: ServerResponse,
  source: AgentHookSource,
  body: unknown,
  headers: IncomingHttpHeaders
): Promise<void> {
  // Why: the body is read, so the slowloris cap must not cut off a plugin still deciding.
  res.socket?.setTimeout(0)
  const answer = await answerAgentToolPluginHooks(source, body, headers)
  if (answer) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(answer)
    return
  }
  res.writeHead(204)
  res.end()
}
