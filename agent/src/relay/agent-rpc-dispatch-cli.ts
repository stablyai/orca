// src/relay/agent-rpc-dispatch-cli.ts
// cli.* (Orca ADR — server-mode CLI install on Dev Server) — split out of
// agent-rpc-dispatch-misc.ts to keep it under the oxlint max-lines budget
// (same reasoning agent-rpc-dispatch-git.ts/-fs.ts/-browser.ts/-vm.ts/
// -hidden-target.ts already split out of the original giant switch).
// Backend relays cli.* to the Dev Server Agent instead of running it on
// the Orca backend container — see backend/src/main/runtime/rpc/methods/cli.ts
// and agent-cli-handler.ts for the full rationale.

import { AgentErrorCode } from '../shared/agent-wire-protocol'
import type { JsonRpcRequest, JsonRpcResponse } from './agent-rpc-dispatch'
import { makeError } from './agent-rpc-dispatch'

export async function dispatchCliRpc(rpc: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  switch (rpc.method) {
    case 'cli.getInstallStatus': {
      try {
        const { handleCliGetInstallStatus } = await import('./agent-cli-handler')
        return (await handleCliGetInstallStatus(rpc.id)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `cli.getInstallStatus unavailable: ${msg}`
        )
      }
    }

    case 'cli.install': {
      try {
        const { handleCliInstall } = await import('./agent-cli-handler')
        return (await handleCliInstall(rpc.id)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `cli.install unavailable: ${msg}`)
      }
    }

    case 'cli.remove': {
      try {
        const { handleCliRemove } = await import('./agent-cli-handler')
        return (await handleCliRemove(rpc.id)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `cli.remove unavailable: ${msg}`)
      }
    }

    case 'cli.getWslInstallStatus': {
      try {
        const { handleCliGetWslInstallStatus } = await import('./agent-cli-handler')
        return (await handleCliGetWslInstallStatus(rpc.id, rpc.params ?? {})) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `cli.getWslInstallStatus unavailable: ${msg}`
        )
      }
    }

    case 'cli.installWsl': {
      try {
        const { handleCliInstallWsl } = await import('./agent-cli-handler')
        return (await handleCliInstallWsl(rpc.id, rpc.params ?? {})) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `cli.installWsl unavailable: ${msg}`)
      }
    }

    case 'cli.removeWsl': {
      try {
        const { handleCliRemoveWsl } = await import('./agent-cli-handler')
        return (await handleCliRemoveWsl(rpc.id, rpc.params ?? {})) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `cli.removeWsl unavailable: ${msg}`)
      }
    }

    default:
      return null
  }
}
