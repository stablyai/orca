import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { isNativeChatEnabled } from '../../../../shared/structured-native-chat-launch-route'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'

type StructuredSessionClient = Pick<RpcContext, 'clientCapabilities' | 'clientKind'>

/**
 * The host asks a structured-session caller one of two questions, and they must not be confused.
 *
 * SERVE — may this client read, drive, stop and close chats that already exist? The negotiated wire
 * capability alone; in-process callers are the same build as the host and negotiate none. The Chat
 * UI setting never enters it: a settings flag must not cut a user off from their own running work.
 *
 * CREATE — may this caller start a NEW structured session? Serving, plus the host's Chat UI setting,
 * which decides how new agent launches open on this host whoever asks (desktop, phone, in-process).
 */
export function canServeStructuredAgentSessions(context: StructuredSessionClient): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) === true
  )
}

export function canCreateStructuredAgentSessions(
  context: StructuredSessionClient & { runtime: Pick<OrcaRuntimeService, 'getClientSettings'> }
): boolean {
  return canServeStructuredAgentSessions(context) && hostChatUiEnabled(context.runtime)
}

function hostChatUiEnabled(runtime: Pick<OrcaRuntimeService, 'getClientSettings'>): boolean {
  try {
    return isNativeChatEnabled(runtime.getClientSettings())
  } catch {
    // An unreadable setting has not said yes, so nothing new is created on its strength.
    return false
  }
}
