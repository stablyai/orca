import type { RpcContext } from '../../core'

export async function callerDispatch(ctx: RpcContext, workspaceId: string): Promise<string> {
  if (ctx.pairedDeviceId) {
    throw new Error('pipeline_local_worker_required')
  }
  // Only host-attested sessions or compatibility evidence can submit, never a declared handle.
  const caller =
    ctx.orchestrationCaller ??
    (ctx.orchestrationCompatibilityEvidence
      ? ctx.runtime.verifyOrchestrationCompatibilityCaller(ctx.orchestrationCompatibilityEvidence)
      : null)
  if (!caller) {
    throw new Error('pipeline_attested_worker_required')
  }
  const callerWorkspace =
    'workspaceId' in caller
      ? caller.workspaceId
      : (await ctx.runtime.showTerminal(caller.terminalHandle)).worktreeId
  if (callerWorkspace !== workspaceId) {
    throw new Error('pipeline_worker_workspace_mismatch')
  }
  const address = 'address' in caller ? caller.address : caller.terminalHandle
  const dispatch = ctx.runtime
    .getOrchestrationDb()
    .getActiveDispatchForIdentity(address, caller.paneKey ?? undefined)
  if (!dispatch) {
    throw new Error('pipeline_active_worker_required')
  }
  return dispatch.id
}
