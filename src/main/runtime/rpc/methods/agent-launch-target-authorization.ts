/**
 * A launch that creates its workspace performs that create, so it needs the create method's own
 * authorization. The mobile allowlist is enforced per method name before dispatch, and `agent.launch`
 * being on it must not let a phone make a workspace its create method would be refused. Reading the
 * same list keeps the two from drifting.
 */

import { AgentLaunchTargetForbiddenError } from '../../../../shared/agent-launch-target-forbidden'
import type { AgentLaunchTarget } from '../../../../shared/agent-launch-intent'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime-rpc/runtime-rpc-mobile-method-allowlist'
import type { RpcContext } from '../core'

const CREATE_METHOD_BY_TARGET_KIND = {
  'create-worktree': 'worktree.create',
  'create-folder-workspace': 'folderWorkspace.create'
} as const satisfies Record<Exclude<AgentLaunchTarget['kind'], 'existing'>, string>

export function assertAgentLaunchTargetAuthorized(
  target: Pick<AgentLaunchTarget, 'kind'>,
  context: Pick<RpcContext, 'clientKind'>
): void {
  // `clientKind` is the paired device's scope, stamped from its validated token.
  if (target.kind === 'existing' || context.clientKind !== 'mobile') {
    return
  }
  if (!MOBILE_RPC_METHOD_ALLOWLIST.has(CREATE_METHOD_BY_TARGET_KIND[target.kind])) {
    throw new AgentLaunchTargetForbiddenError()
  }
}
