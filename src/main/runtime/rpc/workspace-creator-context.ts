import type { WorkspaceCreatorProvenance } from '../../../shared/worktree/types'
import type { RpcContext } from './core'

export function resolveRpcWorkspaceCreatorProvenance(
  context: Pick<
    RpcContext,
    'caller' | 'pairedDeviceId' | 'clientId' | 'clientKind' | 'connectionId'
  >
): WorkspaceCreatorProvenance {
  if (context.pairedDeviceId) {
    return { kind: 'paired-device', deviceId: context.pairedDeviceId }
  }
  // Why: a local stream declares a client but is the runtime socket's owner, so it creates as the CLI does.
  if (context.caller?.kind === 'local-cli') {
    return { kind: 'host' }
  }
  if (context.clientId || context.clientKind || context.connectionId) {
    throw new Error('authenticated_device_identity_missing')
  }
  return { kind: 'host' }
}
