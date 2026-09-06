import * as ExpoCrypto from 'expo-crypto'
import {
  decodeAccountsSnapshot,
  type ProviderKey,
  type RateLimitRuntimeTarget
} from '../components/account-usage-state'
import { requestCodexResetCredit } from '../components/codex-reset-credit'
import { readCodexResetCreditCapability } from '../components/codex-reset-credit-capability'
import { loadHosts } from '../transport/host-store'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import type { HostAccountsOperations } from './host-accounts-operations'

export function nativeHostAccountsOperations(
  client: RpcClient,
  hostId: string
): HostAccountsOperations {
  return {
    async loadHostName(hostId) {
      return (await loadHosts()).find((host) => host.id === hostId)?.name ?? null
    },
    async snapshot() {
      const response = await client.sendRequest('accounts.list')
      requireSuccess(response)
      return decodeAccountsSnapshot((response as RpcSuccess).result)
    },
    async select(provider, accountId, codexTarget) {
      const method = selectionMethod(provider, codexTarget)
      const params =
        provider === 'codex' && codexTarget?.runtime === 'wsl'
          ? { accountId, target: codexTarget }
          : { accountId }
      requireSuccess(await client.sendRequest(method, params))
    },
    readCodexResetCreditCapability() {
      return readCodexResetCreditCapability(client)
    },
    consumeCodexResetCredit(expectedScope) {
      return requestCodexResetCredit(client, {
        hostId,
        expectedScope,
        createIdempotencyKey: () => ExpoCrypto.randomUUID()
      })
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
