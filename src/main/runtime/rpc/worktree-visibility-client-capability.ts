import { WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RpcContext } from './core'

export function supportsWorktreeVisibilitySourceDefaults(
  context: Pick<RpcContext, 'clientCapabilities'>,
  requestSupport = false
): boolean {
  return (
    requestSupport ||
    context.clientCapabilities === undefined ||
    context.clientCapabilities.includes(WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY)
  )
}
