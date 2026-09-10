import {
  decodeAccountsSnapshot,
  type ProviderKey,
  type RateLimitRuntimeTarget
} from '../components/account-usage-state'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import type { HostAccountOperations } from './host-account-operations'

export function nativeHostAccountOperations(client: RpcClient): HostAccountOperations {
  return {
    async snapshot() {
      const response = await client.sendRequest('accounts.list')
      requireSuccess(response)
      return decodeAccountsSnapshot((response as RpcSuccess).result)
    },
    async select(provider, accountId, codexTarget) {
      // Why: old hosts silently strip unknown target fields. Use the distinct
      // targeted RPC for WSL so version skew fails before mutating host state.
      const method = selectionMethod(provider, codexTarget)
      const params =
        provider === 'codex' && codexTarget?.runtime === 'wsl'
          ? { accountId, target: codexTarget }
          : { accountId }
      requireSuccess(await client.sendRequest(method, params))
    },
    subscribe(listener, onInvalid) {
      return client.subscribe('accounts.subscribe', null, (payload) => {
        if (!payload || typeof payload !== 'object') {
          return
        }
        const event = payload as { type?: string; snapshot?: unknown }
        if (event.type === 'ready' || event.type === 'snapshot') {
          try {
            listener(decodeAccountsSnapshot(event.snapshot))
          } catch {
            onInvalid?.()
          }
        }
      })
    }
  }
}

function selectionMethod(
  provider: ProviderKey,
  target?: RateLimitRuntimeTarget | null
): 'accounts.selectClaude' | 'accounts.selectCodex' | 'accounts.selectCodexForTarget' {
  if (provider === 'claude') {
    return 'accounts.selectClaude'
  }
  return target?.runtime === 'wsl' ? 'accounts.selectCodexForTarget' : 'accounts.selectCodex'
}

function requireSuccess(response: { ok: boolean; error?: { message?: string } }): void {
  if (!response.ok) {
    throw new Error(response.error?.message ?? 'Account operation failed')
  }
}
