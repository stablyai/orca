// src/relay/agent-rpc-dispatch-accounts.ts
// accounts.* — split out of agent-rpc-dispatch-misc.ts to keep it under the
// oxlint max-lines budget (same reasoning agent-rpc-dispatch-git.ts/-fs.ts/
// -browser.ts/-vm.ts/-cli.ts/-hidden-target.ts already split out of the
// original giant switch).
// TASK-023: backs infra-fleet-service's Relay RPC and api-gateway's
// wscompat channels_accounts.go, which forward {accountId} params straight
// through to these methods (see accounts-handler.ts's module doc comment
// for the single-pseudo-account design this implements).

import { AgentErrorCode } from '../shared/agent-wire-protocol'
import type { JsonRpcRequest, JsonRpcResponse } from './agent-rpc-dispatch'
import { makeError } from './agent-rpc-dispatch'

export async function dispatchAccountsRpc(rpc: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  switch (rpc.method) {
    case 'accounts.selectClaude': {
      try {
        const { handleAccountsSelectClaude } = await import('./accounts-handler')
        return (await handleAccountsSelectClaude(rpc.id, rpc.params ?? {})) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `accounts.selectClaude unavailable: ${msg}`
        )
      }
    }

    case 'accounts.selectCodex': {
      try {
        const { handleAccountsSelectCodex } = await import('./accounts-handler')
        return (await handleAccountsSelectCodex(rpc.id, rpc.params ?? {})) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `accounts.selectCodex unavailable: ${msg}`
        )
      }
    }

    case 'accounts.removeClaude': {
      try {
        const { handleAccountsRemoveClaude } = await import('./accounts-handler')
        return (await handleAccountsRemoveClaude(rpc.id, rpc.params ?? {})) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `accounts.removeClaude unavailable: ${msg}`
        )
      }
    }

    case 'accounts.removeCodex': {
      try {
        const { handleAccountsRemoveCodex } = await import('./accounts-handler')
        return (await handleAccountsRemoveCodex(rpc.id, rpc.params ?? {})) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `accounts.removeCodex unavailable: ${msg}`
        )
      }
    }

    // ── accounts.getSnapshot ─────────────────────────────────────────────────
    // Backs api-gateway's accounts.subscribe poll loop (BUG-005/SOL-005's
    // session-client push bridge) — read-only, no accountId param. See
    // accounts-handler.ts's getAccountsSnapshot doc comment.
    case 'accounts.getSnapshot': {
      try {
        const { handleAccountsGetSnapshot } = await import('./accounts-handler')
        return (await handleAccountsGetSnapshot(rpc.id)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `accounts.getSnapshot unavailable: ${msg}`
        )
      }
    }

    default:
      return null
  }
}
