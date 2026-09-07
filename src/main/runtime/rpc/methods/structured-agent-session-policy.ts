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

export function supportsStructuredAgentSessions(context: StructuredPolicyContext): boolean {
  if (context.clientKind === undefined) {
    return true
  }
  const hasCapability =
    context.clientCapabilities?.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) === true
  if (!hasCapability) {
    return false
  }
  if (context.clientKind !== 'mobile') {
    return true
  }
  return (
    context.structuredNativeChatEnabled === true ||
    (context.runtime ? isStructuredNativeChatEnabled(context.runtime) : false)
  )
}

export function structuredNativeChatProjectionEnabled(args: {
  clientKind: 'mobile' | 'runtime' | undefined
  clientCapabilities: readonly RuntimeCapability[] | undefined
  structuredNativeChatEnabled?: boolean
}): boolean {
  return supportsStructuredAgentSessions(args)
}
