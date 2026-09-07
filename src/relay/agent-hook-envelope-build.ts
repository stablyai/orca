// Pure mapping from a parsed hook event plus its raw body onto the `agent.hook` envelope that goes
// over the SSH channel. Sits beside agent-hook-envelope-publication.ts, which owns shedding and
// redelivery of the same envelope.
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentHookRelayEnvelope, AgentHookSource } from '../shared/agent-hook-relay'

// Why: cap metadata to prevent a misbehaving CLI growing the cache unboundedly.
const MAX_HOOK_META_LEN = 64

export function buildRelayHookEnvelope(
  event: AgentHookEventPayload,
  source: AgentHookSource,
  env?: string,
  version?: string,
  options: { isReplay?: boolean } = {}
): AgentHookRelayEnvelope {
  return {
    source,
    paneKey: event.paneKey,
    ...(event.launchToken ? { launchToken: event.launchToken } : {}),
    tabId: event.tabId,
    worktreeId: event.worktreeId,
    connectionId: null,
    hasExplicitPrompt: event.hasExplicitPrompt,
    promptInteractionKey: event.promptInteractionKey,
    hookEventName: event.hookEventName,
    providerPromptId: event.providerPromptId,
    compactTrigger: event.compactTrigger,
    toolUseId: event.toolUseId,
    toolAgentId: event.toolAgentId,
    teammateName: event.teammateName,
    toolAgentType: event.toolAgentType,
    claudeRunningNonAgentTask: event.claudeRunningNonAgentTask,
    ...(event.providerSession ? { providerSession: event.providerSession } : {}),
    ...(event.providerSessionOnly ? { providerSessionOnly: true } : {}),
    isReplay: options.isReplay === true ? true : undefined,
    env,
    version,
    payload: event.payload
  }
}

export function hookBodyEnv(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined
  }
  const v = (body as Record<string, unknown>).env
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_HOOK_META_LEN) {
    return undefined
  }
  return v
}

export function hookBodyVersion(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined
  }
  const v = (body as Record<string, unknown>).version
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_HOOK_META_LEN) {
    return undefined
  }
  return v
}
