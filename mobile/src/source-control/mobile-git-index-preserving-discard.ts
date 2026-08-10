import { assertGitIndexPreservingDiscardCapability } from '../../../src/shared/git-index-preserving-discard-capability'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcSuccess } from '../transport/types'

export async function sendMobileIndexPreservingDiscard(
  client: Pick<RpcClient, 'sendRequest'>,
  params: { worktree: string; filePath: string }
): Promise<unknown> {
  const statusResponse = await client.sendRequest('status.get')
  if (!statusResponse.ok) {
    throw new Error((statusResponse as RpcFailure).error.message)
  }
  assertGitIndexPreservingDiscardCapability((statusResponse as RpcSuccess).result)
  const discardResponse = await client.sendRequest('git.discardFromIndex', params)
  if (!discardResponse.ok) {
    throw new Error((discardResponse as RpcFailure).error.message)
  }
  return (discardResponse as RpcSuccess).result
}
