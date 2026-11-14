import * as z from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { SendRequestOptions } from '../../transport/rpc/unvalidated-rpc-request-port'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import { readConnectionStatusProbe } from '../../transport/connection/runtime-status-probe'
import { GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY } from '../../../../src/shared/source-control/runtime/source-control-runtime-capabilities'
import { GITHUB_EXACT_OPERATION_UNSUPPORTED } from '../../../../src/shared/github/work-items/work-item-target'

export const GITHUB_CONNECTION_CHANGED = 'The Orca server connection changed. Try again.'
export const GITHUB_TARGET_CHECK_TIMED_OUT = 'Timed out confirming the executing Orca server.'
// The paired desktop relays to the executing server; when only it lacks the check, it is the one to update.
export const GITHUB_DESKTOP_UPDATE_REQUIRED =
  'Update Orca desktop to edit this item or load its repository options.'
const authorityStatusSchema = z.looseObject({
  runtimeId: z.string().optional(),
  hostDescriptor: z.looseObject({ installationId: z.string() }).optional(),
  capabilities: z.array(z.string()).optional()
})
const statusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'status.github-target-authority',
    method: 'status.get',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-authority', authorityStatusSchema)
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
  const current = () =>
    !retired &&
    isCurrent() &&
    client.getGeneration?.() === generation &&
    client.getState() === 'connected'
  const assertCurrent = () => {
    if (!current()) {
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
      // A direct connection's answering server can't change within one connection, so its proven status stands.
      const probed = authorityStatusSchema.safeParse(readConnectionStatusProbe(client))
      if (probed.success) {
        return probed.data
      }
      const startedAt = Date.now()
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
        // Nothing was sent, so trying again is safe. A check that ran out its own deadline on a connection that
        // never changed timed out; any other failure is a lost or changed connection.
        const timedOut =
          options.timeoutMs !== undefined &&
          Date.now() - startedAt >= options.timeoutMs &&
          current()
        throw new Error(timedOut ? GITHUB_TARGET_CHECK_TIMED_OUT : GITHUB_CONNECTION_CHANGED)
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
