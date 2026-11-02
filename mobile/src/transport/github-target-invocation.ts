import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from './rpc-operation'
import { rpcResultVariant } from './rpc-operation-result-reader'
import type { RpcClient, SendRequestOptions } from './rpc-client'
import type { RpcResponse } from './types'
import { GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY } from '../../../src/shared/source-control-runtime-capabilities'
import { GITHUB_EXACT_OPERATION_UNSUPPORTED } from '../../../src/shared/github/work-item-target'

export const GITHUB_CONNECTION_CHANGED = 'The Orca server connection changed. Try again.'
const statusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'status.github-target-authority',
    method: 'status.get',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'github-authority',
      z.looseObject({
        runtimeId: z.string().optional(),
        hostDescriptor: z.looseObject({ installationId: z.string() }).optional(),
        capabilities: z.array(z.string()).optional()
      })
    )
  })
)

export function captureGitHubInvocation(client: RpcClient, isCurrent: () => boolean = () => true) {
  const generation = client.getGeneration?.()
  let retired = client.getState() !== 'connected'
  const unsubscribe = client.onStateChange((state) => {
    if (state !== 'connected') {
      retired = true
    }
  })
  const assertCurrent = () => {
    if (
      retired ||
      !isCurrent() ||
      client.getGeneration?.() !== generation ||
      client.getState() !== 'connected'
    ) {
      throw new Error(GITHUB_CONNECTION_CHANGED)
    }
  }
  return {
    assertCurrent,
    retire: () => {
      retired = true
      unsubscribe()
    },
    // The check runs before the action is sent, so its failures say what the user can do, not which RPC failed.
    async status(options: SendRequestOptions) {
      assertCurrent()
      let reply: RpcResponse
      try {
        reply = await statusRead.request(client, undefined, {
          ...options,
          beforeSend: assertCurrent
        })
      } catch (error) {
        if (error instanceof Error && error.message === GITHUB_CONNECTION_CHANGED) {
          throw error
        }
        // A timeout or lost connection: nothing was sent, so trying again is safe.
        throw new Error(GITHUB_CONNECTION_CHANGED)
      }
      let status: ReturnType<typeof statusRead.interpret>
      try {
        status = statusRead.interpret(reply)
      } catch {
        // A refused or unreadable answer: this server can't confirm the exact target.
        throw new Error(GITHUB_EXACT_OPERATION_UNSUPPORTED)
      }
      assertCurrent()
      return status
    }
  }
}

export function supportsExactGitHubOperations(status: { capabilities?: string[] }): boolean {
  return status.capabilities?.includes(GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY) === true
}
export function requireExactGitHubOperations(status: { capabilities?: string[] }): void {
  if (!supportsExactGitHubOperations(status)) {
    throw new Error(GITHUB_EXACT_OPERATION_UNSUPPORTED)
  }
}

// Runtime-source errors describe terminal launch recovery; GitHub actions have their own existing remedy.
export function githubOperationResponse(response: RpcResponse): RpcResponse {
  if (
    !response.ok &&
    ['runtime_source_mismatch', 'runtime_source_unverifiable'].includes(response.error.code)
  ) {
    return { ...response, error: { ...response.error, message: GITHUB_CONNECTION_CHANGED } }
  }
  return response
}
