import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'
import type { GitHubOwnerRepo } from '../../../src/shared/github/pull-request-types'
import { GITHUB_EXACT_OPERATION_UNSUPPORTED } from '../../../src/shared/github/work-item-target'
import {
  captureGitHubInvocation,
  supportsExactGitHubOperations,
  githubOperationResponse
} from '../transport/github-target-invocation'

export async function withGitHubTargetOperation<T>(args: {
  client: RpcClient
  params: { repo: string }
  ownerRepo: GitHubOwnerRepo
  read?: boolean
  send: (
    client: RpcClient,
    exact: { ownerRepo?: GitHubOwnerRepo },
    options: SendRequestOptions
  ) => Promise<T>
}): Promise<T> {
  const { client, intermediary } = args.client.requestRoute?.(args.params) ?? {
    client: args.client
  }
  const invocation = captureGitHubInvocation(client)
  const { assertCurrent } = invocation
  const options = { timeoutMs: 30_000, failWhenDisconnected: true, beforeSend: assertCurrent }
  try {
    assertCurrent()
    // Both legs must honor the existing source fence for capability-shaped generic operations.
    const relayStatus = intermediary ? await invocationStatus(intermediary, options) : null
    assertCurrent()
    const status = await invocation.status(options)
    assertCurrent()
    const supports =
      supportsExactGitHubOperations(status) &&
      (!intermediary || (relayStatus !== null && supportsExactGitHubOperations(relayStatus)))
    const source =
      status.runtimeId && status.hostDescriptor?.installationId
        ? { sourceId: status.hostDescriptor.installationId, runtimeId: status.runtimeId }
        : null
    if ((!supports || !source) && !args.read) {
      throw new Error(GITHUB_EXACT_OPERATION_UNSUPPORTED)
    }
    const result = await args.send(
      {
        ...client,
        sendRequest: async (method, params, requestOptions) =>
          githubOperationResponse(await client.sendRequest(method, params, requestOptions))
      },
      supports && source ? { ownerRepo: args.ownerRepo } : {},
      {
        ...options,
        ...(supports && source ? { envelope: { expectedRuntimeSource: source } } : {})
      }
    )
    if (args.read) {
      assertCurrent()
    }
    return result
  } finally {
    invocation.retire()
  }
}

async function invocationStatus(client: RpcClient, options: SendRequestOptions) {
  const invocation = captureGitHubInvocation(client)
  try {
    return await invocation.status(options)
  } finally {
    invocation.retire()
  }
}
