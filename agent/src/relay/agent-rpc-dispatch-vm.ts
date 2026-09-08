// src/relay/agent-rpc-dispatch-vm.ts
// vm.exec / vm.provision / vm.cancelProvision — split out of
// agent-rpc-dispatch-misc.ts to keep it under the oxlint max-lines budget
// (same reasoning agent-rpc-dispatch-git.ts/-fs.ts/-browser.ts/
// -hidden-target.ts already split out of the original giant switch).
// CR-EVM-001/003, TASK-AG-EVM-001/002/003.

import type WebSocket from 'ws'
import type { WireState } from 'orca-dev-agent-transport'
import { AgentErrorCode } from '../shared/agent-wire-protocol'
import type { JsonRpcRequest, JsonRpcResponse } from './agent-rpc-dispatch'
import { makeError } from './agent-rpc-dispatch'

export async function dispatchVmRpc(
  rpc: JsonRpcRequest,
  ws: WebSocket,
  // Why: vm.provision (TASK-AG-EVM-003) streams stream.chunk/stream.end
  // frames the same way git.execStream's handler does — needs WireState.
  state: WireState
): Promise<JsonRpcResponse | null> {
  switch (rpc.method) {
    // ─── vm.exec (ephemeral VM: suspend/resume/destroy, one-shot) ───────────
    // CR-EVM-001/TASK-AG-EVM-001: backend-go's ephemeral_vm_relay.go already
    // calls vm.exec — this closes the runtime gap (was previously unanswered).
    case 'vm.exec': {
      try {
        const { handleVmExec, validateVmExecParams } = await import('./agent-ephemeral-vm-handler')
        const params = validateVmExecParams(rpc.params)
        const result = await handleVmExec(params)
        return { jsonrpc: '2.0', id: rpc.id, result }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `vm.exec failed: ${msg}`)
      }
    }

    // ── vm.provision (ephemeral VM: mode 'create', streaming) ────────────────
    // CR-EVM-003/TASK-AG-EVM-003. Mirrors git.execStream's convention exactly
    // (confirmed by reading agent-rpc-dispatch-git.ts's real case, not the
    // sketch — see this task's "Kết quả thực tế" for the mismatch): fire the
    // handler without awaiting it (it sends its own stream.chunk/stream.end
    // frames asynchronously), and return a single 'stream.started' response
    // synchronously. This is NOT "no response frame" as SOL-AG-EVM-002/this
    // task's original sketch assumed.
    case 'vm.provision': {
      try {
        const { handleVmProvision, validateVmProvisionParams } =
          await import('./agent-ephemeral-vm-handler')
        const params = validateVmProvisionParams(rpc.params)
        void handleVmProvision(ws, state, rpc.id, params)
        return { jsonrpc: '2.0', id: rpc.id, result: { type: 'stream.started' } }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `vm.provision unavailable: ${msg}`)
      }
    }

    // ── vm.cancelProvision (ordinary request/response) ───────────────────────
    case 'vm.cancelProvision': {
      try {
        const { handleVmCancelProvision, validateRuntimeIdParam } =
          await import('./agent-ephemeral-vm-handler')
        const params = validateRuntimeIdParam(rpc.params)
        const result = await handleVmCancelProvision(params)
        return { jsonrpc: '2.0', id: rpc.id, result }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `vm.cancelProvision unavailable: ${msg}`
        )
      }
    }

    // ── vm.readCredentialFile (Hướng B only) ──────────────────────────────
    // CR-EVM-005/TASK-AG-EVM-009: backend-go's BackendRelaySshProvisioner
    // calls this BEFORE dialing off-machine itself, to read identityFile's
    // bytes from the same agent that ran Provision. Hướng A never calls
    // this — dialOutboundSshTarget (vm.sshDial's handler) reads the file
    // itself, see TASK-AG-EVM-008.
    case 'vm.readCredentialFile': {
      try {
        const { handleVmReadCredentialFile, validateVmReadCredentialFileParams } =
          await import('./agent-ephemeral-vm-handler')
        const params = validateVmReadCredentialFileParams(rpc.params)
        const result = await handleVmReadCredentialFile(params)
        return { jsonrpc: '2.0', id: rpc.id, result }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `vm.readCredentialFile failed: ${msg}`)
      }
    }

    default:
      return null
  }
}
