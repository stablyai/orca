import type { RpcClient } from '../transport/rpc-client'
import { activateMobileSessionFileTab } from '../session/mobile-session-file-tab-activation'
import { mobileWebBrokerHostRpcError } from './mobile-web-broker-error'

export async function executeMobileWebFileOpenOperation(args: {
  client: RpcClient
  hostWorkspaceId: string
  relativePath: string
  assertCurrent: () => void
}): Promise<null> {
  const response = await args.client.sendRequest('files.open', {
    worktree: `id:${args.hostWorkspaceId}`,
    relativePath: args.relativePath
  })
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  await activateMobileSessionFileTab({
    client: args.client,
    worktreeId: args.hostWorkspaceId,
    relativePath: args.relativePath,
    tabMode: 'edit',
    staged: false,
    isCurrent: () => {
      args.assertCurrent()
      return true
    }
  })
  return null
}
