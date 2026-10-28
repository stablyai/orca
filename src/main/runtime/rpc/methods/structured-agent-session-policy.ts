import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import { AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY } from '../../../../shared/agent-session-optional-model-capability'
import {
  isNativeChatDefaultFor,
  isNativeChatEnabled
} from '../../../../shared/structured-native-chat-launch-route'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { readAgentLaunchModeSettings } from '../../../agent-launch/agent-launch-mode'
import type { RpcContext } from '../core'

export function clientReadsOptionsWithoutModel(
  context: Pick<RpcContext, 'clientCapabilities' | 'clientKind'>
): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY) === true
  )
}

/** Admit by client wire capability, independent of the host user's launch preference. In-process callers share this build and need no negotiation. */
export function supportsStructuredAgentSessions(
  context: Pick<RpcContext, 'clientCapabilities' | 'clientKind'>
): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) === true
  )
}

/** One audience rule for tabs and restart offers. Pi also needs dialog-shape support. */
export function clientRendersStructuredAgent(
  clientCapabilities: readonly RuntimeCapability[] | undefined,
  agent: string
): boolean {
  if (!clientCapabilities?.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)) {
    return false
  }
  if (agent === 'codex') {
    return true
  }
  if (agent === 'pi' && !clientCapabilities.includes(PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY)) {
    return false
  }
  return clientCapabilities.includes(
    agent === 'claude'
      ? CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
      : STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
  )
}

/** History opens Claude/Codex for any structured-capable client; other agents require explicit rendering support. */
export function clientOpensStructuredChatFromHistory(
  context: Pick<RpcContext, 'clientCapabilities' | 'clientKind'>,
  agent: string
): boolean {
  return (
    supportsStructuredAgentSessions(context) &&
    (context.clientKind === undefined ||
      isAgentSessionHandleProvider(agent) ||
      clientRendersStructuredAgent(context.clientCapabilities, agent))
  )
}

/** Preserve the existing session audience for every agent except Pi. */
export function clientReadsStructuredSessionAgent(
  context: Pick<RpcContext, 'clientCapabilities' | 'clientKind'>,
  agent: string
): boolean {
  return (
    agent !== 'pi' ||
    context.clientKind === undefined ||
    clientRendersStructuredAgent(context.clientCapabilities, agent)
  )
}

/** Scope offers to readable registered/saved agents; undefined means all are readable and one unscoped fence applies. */
export function structuredAgentsReadBy(
  context: Pick<RpcContext, 'clientCapabilities' | 'clientKind'>,
  agents: readonly string[]
): ((agent: string) => boolean) | undefined {
  if (context.clientKind === undefined) {
    return undefined
  }
  const reads = (agent: string) => clientRendersStructuredAgent(context.clientCapabilities, agent)
  return agents.every(reads) ? undefined : reads
}

/**
 * COMPAT(released phones): a remote client that does not pick each launch's mode itself reads
 * `agentSession.createSupport` as "should this launch be a chat", which the host's setting
 * answered. Remove once the oldest supported phone build launches agents through `agent.launch`.
 */
export function createSupportFollowsHostSetting(
  context: Pick<RpcContext, 'clientCapabilities' | 'clientKind'>
): boolean {
  return (
    context.clientKind !== undefined &&
    context.clientCapabilities?.includes(STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY) !==
      true
  )
}

/** This host's resolved preference; session audience remains independent of new launches. */
export function isStructuredNativeChatDefaultFor(
  runtime: Parameters<typeof readAgentLaunchModeSettings>[0],
  agent: string
): boolean {
  const settings = readAgentLaunchModeSettings(runtime)
  return isTuiAgent(agent) ? isNativeChatDefaultFor(settings, agent) : isNativeChatEnabled(settings)
}
