import { remoteRpcContentBudget } from '../../../../shared/remote-rpc-content-budget'

export function remoteFileContentBudget(
  clientKind: 'mobile' | 'runtime' | undefined,
  requestId: string | undefined
): number | undefined {
  return clientKind && requestId ? remoteRpcContentBudget(requestId) : undefined
}
