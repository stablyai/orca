import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
/** Authorize workspace creation against its own method allowlist; mobile access to agent.launch must not bypass create restrictions. */

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

/** agent.launch.v2 declares support for both outcomes. CLI/runtime-socket and SSH bridges have no clientKind/capabilities; the desktop renderer is a runtime client and must advertise support. */
export function supportsAgentLaunch(
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>
): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(AGENT_LAUNCH_RUNTIME_CAPABILITY) === true
  )
}
