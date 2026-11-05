import type { RpcRequest, RpcResponse } from './mock-server-rpc-handlers'
import {
  consumeMockCodexResetCredit,
  createMockAccountsSnapshot,
  selectMockClaudeAccount,
  selectMockCodexAccount
} from './mock-server-account-state'

type Respond = (response: RpcResponse) => void
type Success = (id: string, result: unknown, streaming?: boolean) => RpcResponse
type ErrorResponse = (id: string, code: string, message: string) => RpcResponse

const accountSubscribers = new Map<string, { requestId: string; respond: Respond }>()

function notifyAccountSubscribers(success: Success): void {
  for (const { requestId, respond } of accountSubscribers.values()) {
    respond(success(requestId, { type: 'snapshot', snapshot: createMockAccountsSnapshot() }, true))
  }
}

export function handleMockAccountRequest(
  request: RpcRequest,
  respond: Respond,
  success: Success,
  error: ErrorResponse
): boolean {
  try {
    switch (request.method) {
      case 'accounts.list':
        respond(success(request.id, createMockAccountsSnapshot()))
        return true
      case 'accounts.selectClaude':
        selectMockClaudeAccount(request.params?.accountId)
        respond(success(request.id, createMockAccountsSnapshot().claude))
        notifyAccountSubscribers(success)
        return true
      case 'accounts.selectCodex':
      case 'accounts.selectCodexForTarget':
        selectMockCodexAccount(request.params?.accountId)
        respond(success(request.id, createMockAccountsSnapshot().codex))
        notifyAccountSubscribers(success)
        return true
      case 'accounts.consumeCodexResetCredit': {
        const result = consumeMockCodexResetCredit(
          request.params?.idempotencyKey,
          request.params?.expectedScope
        )
        respond(
          success(request.id, {
            ...result,
            snapshot: createMockAccountsSnapshot()
          })
        )
        notifyAccountSubscribers(success)
        return true
      }
      case 'accounts.subscribe':
        accountSubscribers.set(`accounts-${request.id}`, { requestId: request.id, respond })
        respond(
          success(
            request.id,
            {
              type: 'ready',
              subscriptionId: `accounts-${request.id}`,
              snapshot: createMockAccountsSnapshot()
            },
            true
          )
        )
        return true
      case 'accounts.unsubscribe':
        if (typeof request.params?.subscriptionId === 'string') {
          accountSubscribers.delete(request.params.subscriptionId)
        }
        respond(success(request.id, { unsubscribed: true }))
        return true
      default:
        return false
    }
  } catch (caught) {
    respond(
      error(
        request.id,
        'invalid_params',
        caught instanceof Error ? caught.message : 'Invalid account request'
      )
    )
    return true
  }
}
