import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'

type StructuredPolicyContext = Pick<RpcContext, 'clientCapabilities' | 'clientKind'> & {
  runtime?: Pick<OrcaRuntimeService, 'getClientSettings'>
  structuredNativeChatEnabled?: boolean
}

export function isStructuredNativeChatEnabled(
  runtime: Pick<OrcaRuntimeService, 'getClientSettings'>
): boolean {
  try {
    return runtime.getClientSettings().experimentalStructuredNativeChat === true
  } catch {
    return false
  }
}

export function supportsStructuredAgentSessionCapability(
  context: Pick<StructuredPolicyContext, 'clientCapabilities' | 'clientKind'>
): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) === true
  )
}

/**
 * One rule for every caller. The host setting is policy and applies to desktop, mobile and
 * in-process callers alike; the negotiated capability is a wire term, so it is asked of remote
 * clients only — in-process callers are the same build as the host and never negotiate one.
 */
export function supportsStructuredAgentSessions(context: StructuredPolicyContext): boolean {
  if (!supportsStructuredAgentSessionCapability(context)) {
    return false
  }
  return (
    context.structuredNativeChatEnabled === true ||
    (context.runtime ? isStructuredNativeChatEnabled(context.runtime) : false)
  )
}

export function structuredNativeChatProjectionEnabled(args: {
  clientKind: 'mobile' | 'runtime' | undefined
  clientCapabilities: readonly RuntimeCapability[] | undefined
  // Required so no call site can silently project as if the host setting were off.
  structuredNativeChatEnabled: boolean
}): boolean {
  return supportsStructuredAgentSessions(args)
}
