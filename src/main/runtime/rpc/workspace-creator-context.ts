import type { WorkspaceCreatorProvenance } from '../../../shared/worktree/types'
import type { RpcContext } from './core'

export function resolveRpcWorkspaceCreatorProvenance(
  context: Pick<
    RpcContext,
    'pairedDeviceId' | 'pairedDeviceParentId' | 'clientId' | 'clientKind' | 'connectionId'
  >
): WorkspaceCreatorProvenance {
  if (context.pairedDeviceId) {
    if (context.clientKind !== 'mobile') {
      return { kind: 'paired-device', deviceId: context.pairedDeviceId }
    }
    // Why the owner, not the phone: a phone acts for whoever paired it, so its rows are theirs.
    return context.pairedDeviceParentId
      ? { kind: 'paired-device', deviceId: context.pairedDeviceParentId }
      : { kind: 'host' }
  }
  if (context.clientId || context.clientKind || context.connectionId) {
    throw new Error('authenticated_device_identity_missing')
  }
  return { kind: 'host' }
}
