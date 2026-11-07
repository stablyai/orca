import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'

/** A title can confirm a hook's wait but never says what it asks; keep the hook's prompt so chat keeps its card. */
export function withWaitPrompt(
  titleOnly: AgentStatusEntry,
  hook: AgentStatusEntry
): AgentStatusEntry {
  if (hook.state !== 'waiting' && hook.state !== 'blocked') {
    return titleOnly
  }
  return {
    ...titleOnly,
    ...(hook.toolName ? { toolName: hook.toolName } : {}),
    ...(hook.toolInput ? { toolInput: hook.toolInput } : {}),
    ...(hook.interactivePrompt ? { interactivePrompt: hook.interactivePrompt } : {})
  }
}
