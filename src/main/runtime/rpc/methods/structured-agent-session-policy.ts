import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import type { StructuredAgentSessionLaunchOrigin } from '../../../../shared/structured-agent-session-create'
import type { StructuredAgentSessionLaunchAuthority } from '../../../../shared/structured-agent-session-create'
import { structuredAgentSessionsEnabled } from '../../../../shared/structured-native-chat-launch-route'

type StructuredPolicyContext = Pick<RpcContext, 'clientCapabilities' | 'clientKind'> & {
  runtime?: Pick<OrcaRuntimeService, 'getClientSettings'>
  structuredNativeChatEnabled?: boolean
}

export function isStructuredNativeChatEnabled(
  runtime: Pick<OrcaRuntimeService, 'getClientSettings'>
): boolean {
  try {
    return structuredAgentSessionsEnabled(runtime.getClientSettings())
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
 * Global structured-chat policy applies to desktop, mobile and in-process callers alike. The
 * work-item-start route has separate local admission below and never changes this decision.
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

export function supportsWorkItemStartStructuredSessionCreate(
  context: Pick<
    RpcContext,
    'clientCapabilities' | 'clientKind' | 'localDesktopAuthority' | 'pairedDeviceId'
  > & {
    runtime: Pick<OrcaRuntimeService, 'getClientSettings'>
  },
  launchOrigin: StructuredAgentSessionLaunchOrigin | undefined
): boolean {
  if (launchOrigin !== 'work-item-start' || !structuredWorkItemStartCallerAuthority(context)) {
    return false
  }
  try {
    return context.runtime.getClientSettings().workItemStartPromptDelivery === 'submit-after-ready'
  } catch {
    return false
  }
}

export function structuredWorkItemStartCallerAuthority(
  context: Pick<
    RpcContext,
    'clientCapabilities' | 'clientKind' | 'localDesktopAuthority' | 'pairedDeviceId'
  >
): StructuredAgentSessionLaunchAuthority | null {
  if (context.clientKind !== 'runtime' || !supportsStructuredAgentSessionCapability(context)) {
    return null
  }
  if (context.localDesktopAuthority === true) {
    return { kind: 'local-desktop' }
  }
  const deviceId = context.pairedDeviceId?.trim()
  return deviceId ? { kind: 'paired-device', deviceId } : null
}
