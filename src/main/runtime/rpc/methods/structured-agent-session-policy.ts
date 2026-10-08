import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'

/**
 * One rule for every caller: can this client read structured sessions? The host's own
 * `experimentalStructuredNativeChat` is not consulted. It is the host user's launch preference,
 * and whether a new agent is a chat is decided by whoever launches it, so a paired client's
 * sessions stay reachable whatever the host's setting says. The negotiated capability is a wire
 * term, asked of remote clients only: in-process callers are the host's own build.
 */
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

/** The agents this client reads rows of, among those registered or saved here; undefined when it
 *  reads every one, so an action for it is exactly the unscoped one (one fence for every offer). */
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

/** An unreadable settings store reads as off, the default. */
export function isStructuredNativeChatEnabled(
  runtime: Pick<OrcaRuntimeService, 'getClientSettings'>
): boolean {
  try {
    return runtime.getClientSettings().experimentalStructuredNativeChat === true
  } catch {
    return false
  }
}
