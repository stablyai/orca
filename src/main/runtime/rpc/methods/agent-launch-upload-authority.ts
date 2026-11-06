/** Uploads for a chat its host has not founded yet. Only the caller's own live prepared launch that
 *  reserved that chat stands in for it, and only while it can still take its input; the store's
 *  ordinary session check is never loosened for any other pending id. */

import { agentSessionOperationKey } from '../../../../shared/agent-session/lifecycle/agent-session-operation-ledger'
import type { AgentSessionAttachmentLaunchAuthority } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store'
import type { RpcContext } from '../core'
import { activeAgentLaunchesFor } from './agent-launch-in-flight'
import { agentLaunchOperationCallerKey } from './agent-launch-replay'
import { assertAgentLaunchTargetAuthorized } from './agent-launch-target-authorization'

export function preparedAgentLaunchUploadAuthority(
  context: RpcContext,
  operationId: string,
  sessionId: string
): AgentSessionAttachmentLaunchAuthority {
  const key = agentSessionOperationKey(agentLaunchOperationCallerKey(context), operationId)
  const active = activeAgentLaunchesFor(context.runtime).get(key)
  const gate = active?.release
  if (!active || !gate || gate.sessionId !== sessionId) {
    throw new Error('This chat is not on this host')
  }
  assertAgentLaunchTargetAuthorized(gate.target, context)
  return {
    // Reread on every step: a launch that ended, or was replaced under its id, grants nothing.
    live: () => activeAgentLaunchesFor(context.runtime).get(key) === active && gate.takesUploads(),
    ended: gate.endedSignal
  }
}
