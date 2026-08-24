import { WORKTREE_RESTORED_AGENT_PRESENCE_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RpcContext } from './core'

export function supportsWorktreeRestoredAgentPresence(
  context: Pick<RpcContext, 'clientCapabilities'>,
  requestSupport = false
): boolean {
  return (
    requestSupport ||
    context.clientCapabilities?.includes(WORKTREE_RESTORED_AGENT_PRESENCE_RUNTIME_CAPABILITY) ===
      true
  )
}
