// src/relay/agent-rpc-dispatch-hidden-target.ts
// vm.sshDial / fs.readDirViaHiddenTarget / fs.readFileViaHiddenTarget /
// git.statusViaHiddenTarget — CR-EVM-005 Hướng A (agent-outbound SSH),
// TASK-AG-EVM-006/007. Split into its own file rather than added to
// agent-rpc-dispatch-misc.ts (as TASK-AG-EVM-006/007's task docs originally
// sketched): agent-rpc-dispatch-misc.ts was already over the oxlint
// `max-lines` budget (300, see .oxlintrc.json) before this CR touched it —
// AGENTS.md forbids adding a max-lines disable or per-file bump, so this
// mirrors the codebase's own established fix for the same problem
// (agent-rpc-dispatch-git.ts/-fs.ts/-git-status.ts/-git-hooks.ts/-browser.ts
// are all splits of the same original giant switch, per their own header
// comments) instead of growing an already-oversized file further.

import { AgentErrorCode } from '../shared/agent-wire-protocol'
import type { JsonRpcRequest, JsonRpcResponse } from './agent-rpc-dispatch'
import { makeError } from './agent-rpc-dispatch'

export async function dispatchHiddenTargetRpc(
  rpc: JsonRpcRequest
): Promise<JsonRpcResponse | null> {
  switch (rpc.method) {
    // ── vm.sshDial (Hướng A: agent-outbound SSH) ──────────────────────────
    // CR-EVM-005/TASK-AG-EVM-006: fired by backend-go's AttachWorkspace path
    // when a runtime's connection is ssh-type and EPHEMERAL_VM_SSH_MODE=
    // agent-outbound (SOL-AG-EVM-003 mục 4) — dials out and registers the
    // resulting hidden target. Ordinary request/response, no streaming.
    case 'vm.sshDial': {
      try {
        const { handleVmSshDial, validateVmSshDialParams } =
          await import('./agent-ephemeral-vm-handler')
        const params = validateVmSshDialParams(rpc.params)
        const result = await handleVmSshDial(params)
        return { jsonrpc: '2.0', id: rpc.id, result }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `vm.sshDial failed: ${msg}`)
      }
    }

    // ── fs.readDirViaHiddenTarget / fs.readFileViaHiddenTarget ─────────────
    // CR-EVM-005/TASK-AG-EVM-007: fs reads for a hidden target's ssh session
    // (registered by vm.sshDial above) — SFTP over the OutboundSshSession,
    // looked up by hiddenTargetId from hiddenTargetRegistry. Method names
    // must match backend-go's TASK-BE-EVM-015 exactly — see that task's own
    // "Kết quả thực tế" for confirmation status.
    case 'fs.readDirViaHiddenTarget': {
      try {
        const { readDirViaHiddenTarget, validateReadDirViaHiddenTargetParams } =
          await import('./ssh-outbound-filesystem-provider')
        const params = validateReadDirViaHiddenTargetParams(rpc.params)
        const result = await readDirViaHiddenTarget(params)
        return { jsonrpc: '2.0', id: rpc.id, result }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `fs.readDirViaHiddenTarget failed: ${msg}`
        )
      }
    }

    case 'fs.readFileViaHiddenTarget': {
      try {
        const { readFileViaHiddenTarget, validateReadFileViaHiddenTargetParams } =
          await import('./ssh-outbound-filesystem-provider')
        const params = validateReadFileViaHiddenTargetParams(rpc.params)
        const result = await readFileViaHiddenTarget(params)
        return { jsonrpc: '2.0', id: rpc.id, result }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `fs.readFileViaHiddenTarget failed: ${msg}`
        )
      }
    }

    // ── git.statusViaHiddenTarget ───────────────────────────────────────────
    // CR-EVM-005/TASK-AG-EVM-007: git status for a hidden target, via `git
    // status --porcelain=v1 -b` over exec() on the OutboundSshSession.
    case 'git.statusViaHiddenTarget': {
      try {
        const { gitStatusViaHiddenTarget, validateGitStatusViaHiddenTargetParams } =
          await import('./ssh-outbound-git-provider')
        const params = validateGitStatusViaHiddenTargetParams(rpc.params)
        const result = await gitStatusViaHiddenTarget(params)
        return { jsonrpc: '2.0', id: rpc.id, result }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `git.statusViaHiddenTarget failed: ${msg}`
        )
      }
    }

    default:
      return null
  }
}
