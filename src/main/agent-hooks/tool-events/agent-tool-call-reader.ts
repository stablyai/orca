import type { z } from 'zod'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { normalizeHookEventName } from '../../../shared/agent-hook-listener/provider-event-names'
import { parseAgentHookJson } from '../../../shared/agent-hook-listener/request-body'
import { parseJsonObjectString } from '../../../shared/agent-hook-listener/interactive-tool'
import {
  normalizeCopilotEventName,
  readCopilotToolCall,
  resolveCopilotEventName
} from '../../../shared/agent-hook-listener/providers/copilot/copilot-tool-fields'
import type { agentToolAfterHookPayloadSchema } from '../../../shared/plugins/events/plugin-hook-payloads'

const BEFORE_EVENTS = new Set([
  'pre_tool_use',
  'before_tool',
  'pre_tool',
  'pre_tool_call',
  'before_shell_execution',
  // Cursor's beforeMCPExecution; the acronym folds into one word.
  'before_mcpexecution',
  'tool.call'
])
const AFTER_EVENTS = new Set([
  'post_tool_use',
  'post_tool_use_failure',
  'after_tool',
  'post_tool',
  'post_tool_call',
  'tool.result'
])

/** The hook event status ingestion accepted; plugins see only calls from the pane's owner. */
export type AgentToolCallOwner = Pick<
  AgentHookEventPayload,
  'paneKey' | 'worktreeId' | 'hookEventName'
>

export type AgentToolCall = {
  phase: 'before' | 'after'
  payload: z.output<typeof agentToolAfterHookPayloadSchema>
}

type ToolFields = { tool?: string; input?: unknown; output?: unknown }

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

// Field names follow each provider's status parser (agent-hook-listener/providers/*-tool-fields).
function readToolFields(
  source: AgentHookSource,
  eventName: string,
  hook: Record<string, unknown>
): ToolFields {
  if (source === 'amp') {
    return {
      tool: firstString(hook, ['tool', 'toolName', 'name']),
      input: firstValue(hook, ['input', 'tool_input', 'arguments']),
      output: firstValue(hook, ['output', 'result', 'error'])
    }
  }
  if (source === 'copilot') {
    const call = readCopilotToolCall(hook)
    const args = hook.toolArgs
    return {
      tool: firstString(hook, ['tool_name', 'toolName', 'name']) ?? call.toolName,
      input:
        firstValue(hook, ['tool_input', 'toolInput']) ??
        parseJsonObjectString(args) ??
        args ??
        firstValue(hook, ['input', 'arguments']) ??
        call.toolInputSource,
      output: firstValue(hook, ['tool_result', 'toolResult', 'tool_response', 'toolResponse'])
    }
  }
  if (source === 'cursor' && eventName === 'before_shell_execution') {
    const command = firstString(hook, ['command'])
    return command ? { tool: 'Shell', input: { command } } : {}
  }
  if (source === 'cursor' && eventName === 'before_mcpexecution') {
    return {
      tool: firstString(hook, ['tool_name']) ?? 'MCP',
      input: firstValue(hook, ['tool_input', 'command', 'url'])
    }
  }
  return {
    tool: firstString(hook, ['tool_name', 'toolName', 'tool']),
    input: firstValue(hook, ['tool_input', 'toolInput', 'input', 'args']),
    output: firstValue(hook, ['tool_response', 'toolResponse', 'tool_output', 'output'])
  }
}

/** The tool call an accepted hook post reports, across agents' field names; null otherwise. */
export function readAgentToolCall(
  source: AgentHookSource,
  body: unknown,
  owner: AgentToolCallOwner
): AgentToolCall | null {
  const rawPayload = record(body)?.payload
  let hook: Record<string, unknown> | null = null
  try {
    hook = record(typeof rawPayload === 'string' ? parseAgentHookJson(rawPayload) : rawPayload)
  } catch {
    return null
  }
  if (!hook) {
    return null
  }
  // Status ingestion already resolved the event; Copilot may only imply it from the payload.
  const eventName = normalizeHookEventName(
    source === 'copilot'
      ? normalizeCopilotEventName(resolveCopilotEventName(owner.hookEventName, hook))
      : owner.hookEventName
  )
  const phase = BEFORE_EVENTS.has(eventName)
    ? 'before'
    : AFTER_EVENTS.has(eventName)
      ? 'after'
      : null
  const { tool, input, output } = readToolFields(source, eventName, hook)
  if (!phase || !tool) {
    return null
  }
  const terminalId = terminalForPaneKey?.(owner.paneKey) ?? undefined
  const callId = firstString(hook, ['tool_use_id', 'toolUseId', 'tool_call_id', 'call_id'])
  return {
    phase,
    payload: {
      agent: source,
      workspaceId: owner.worktreeId ?? null,
      ...(terminalId ? { terminalId } : {}),
      tool: tool.slice(0, 256),
      input: input ?? null,
      ...(callId ? { callId: callId.slice(0, 256) } : {}),
      ...(phase === 'after' && output !== undefined ? { output } : {})
    }
  }
}
