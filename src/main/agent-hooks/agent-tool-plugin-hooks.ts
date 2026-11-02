import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { PLUGIN_HOOK_SPECS } from '../../shared/plugins/events/plugin-hook-payloads'
import {
  notifyPluginHook,
  PluginHookDeniedError,
  pluginHookWanted,
  runPluginHook
} from '../plugins/hooks/plugin-hook-dispatch'
import { readAgentToolCall, type AgentToolCallOwner } from './agent-tool-call-reader'

/** Sent by hook scripts that print Orca's answer as Claude Code's PreToolUse decision. */
export const AGENT_TOOL_DECISION_HEADER = 'x-orca-hook-decision'
export const CLAUDE_PRE_TOOL_USE_DECISION = 'claude-pre-tool-use-v1'
// Why 6 s: the script waits 8 s at most, so Orca answers (or passes) before it gives up.
const DECISION_BUDGET_MS = 6_000

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
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
  headers: IncomingHttpHeaders,
  owner: AgentToolCallOwner
): Promise<string | null> {
  const wantsBefore = pluginHookWanted('agent.tool.before')
  if (!wantsBefore && !pluginHookWanted('agent.tool.after')) {
    return null
  }
  const call = readAgentToolCall(source, body, owner)
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

/**
 * Ends a hook post: 200 with the agent's decision when a plugin made one, else 204 as before.
 * `owner` is the event status ingestion accepted; null (rejected or fenced) skips plugins.
 */
export async function respondAfterAgentToolPluginHooks(
  res: ServerResponse,
  source: AgentHookSource,
  body: unknown,
  headers: IncomingHttpHeaders,
  owner: AgentToolCallOwner | null
): Promise<void> {
  // The usual case: no plugin listens, so answer at once without reading the call.
  if (!owner || (!pluginHookWanted('agent.tool.before') && !pluginHookWanted('agent.tool.after'))) {
    res.writeHead(204)
    res.end()
    return
  }
  // Why: the body is read, so the slowloris cap must not cut off a plugin still deciding.
  res.socket?.setTimeout(0)
  const answer = await answerAgentToolPluginHooks(source, body, headers, owner)
  if (answer) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(answer)
    return
  }
  res.writeHead(204)
  res.end()
}
