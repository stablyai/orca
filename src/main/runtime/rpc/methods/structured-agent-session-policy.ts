import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
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
