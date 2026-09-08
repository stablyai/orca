import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import { executeMobileWebWorkspaceCreationCreateOperation } from './mobile-web-workspace-creation-create-operations'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import type { MobileWebWorkspaceSnapshotPager } from './mobile-web-workspace-snapshot-pager'

/** What is left of the workspace translator: the catalog read that mints the page's workspace
 * handles, and workspace creation. Every other workspace call reaches the desktop unchanged
 * through `workspace.hostRequest`. */
export async function executeMobileWebWorkspaceOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  authority: MobileWebWorkspaceAuthority
  snapshots: MobileWebWorkspaceSnapshotPager
  isRequestActive: () => boolean
}): Promise<unknown> {
  if (args.operation === 'snapshot') {
    return args.snapshots.snapshot(args.payload, args.client, args.authority)
  }
  if (args.operation.startsWith('creationCreate')) {
    return executeMobileWebWorkspaceCreationCreateOperation(args)
  }
  throw new MobileWebBrokerError('unsupported_capability')
}
