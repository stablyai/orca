// src/relay/agent-ephemeral-vm-handler.ts
// vm.exec (suspend/resume/destroy, one-shot) — CR-EVM-001 / TASK-AG-EVM-001.
// Closes a real runtime gap: backend-go's ephemeral_vm_relay.go already calls
// vm.exec (3 call sites) but no agent-side handler existed to answer it.
// Reuses runRecipeCommand (ephemeral-vm-recipe-process.ts) — same process
// runner desktop-local exec already depends on (ephemeral-vm-recipe-runner.ts).
//
// vm.provision (mode 'create', streaming) — TASK-AG-EVM-002/SOL-AG-EVM-002.
// Reuses the git.execStream wire shape (stream.chunk/stream.end frames) —
// see agent-git-handler.ts's handleGitExecStream, the real precedent this
// mirrors. NOTE: SOL-AG-EVM-002's sketch imports `sendFrame` from a
// './protocol' module — no such module exists. The real precedent
// (agent-git-handler.ts) defines `sendFrame` as a local, non-exported
// helper using `encodeDataFrame`/`WireState` from 'orca-dev-agent-transport'
// — mirrored here instead of the sketch.
//
// vm.sshDial (Hướng A: agent-outbound SSH) — TASK-AG-EVM-006/SOL-AG-EVM-003
// "Quyết định đã chốt" mục 1, 3. Dials out via ssh-outbound-client.ts's
// dialOutboundSshTarget and keeps the live session in an in-memory
// runtimeId -> OutboundSshSession registry (hiddenTargetRegistry) —
// mirrors provisionAbortRegistry's precedent just above: no persistence,
// lost on agent restart by design (backend-go re-dials, see SOL mục 3).

import type WebSocket from 'ws'
import { encodeDataFrame } from 'orca-dev-agent-transport'
import type { WireState } from 'orca-dev-agent-transport'
import { runRecipeCommand } from '../shared/ephemeral-vm-recipe-process'
import type { EphemeralVmRecipeContext } from '../shared/ephemeral-vm-recipe-runner'
import { parseEphemeralVmRecipeResult } from '../shared/ephemeral-vm-recipes'
import { dialOutboundSshTarget } from './ssh-outbound-client'
import type { OutboundSshSession, SshDialTarget } from './ssh-outbound-client'

export type VmExecParams = {
  repoPath: string
  command: string
  phase: 'suspend' | 'resume' | 'destroy'
  recipeId: string
  runtimeId: string
}

const VM_EXEC_PHASES = new Set(['suspend', 'resume', 'destroy'])

// Why: agent-rpc-dispatch-misc.ts has no shared requiredString-style param
// validator (confirmed by reading the file — every other case there passes
// rpc.params straight through to its handler); this local helper keeps
// vm.exec's own validation in one place instead of duplicating the check.
function requiredStringField(params: Record<string, unknown>, name: string): string {
  const value = params[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`vm.exec: missing required param "${name}"`)
  }
  return value
}

export function validateVmExecParams(params: unknown): VmExecParams {
  const p = (params ?? {}) as Record<string, unknown>
  const repoPath = requiredStringField(p, 'repoPath')
  const command = requiredStringField(p, 'command')
  const phase = requiredStringField(p, 'phase')
  const recipeId = requiredStringField(p, 'recipeId')
  const runtimeId = requiredStringField(p, 'runtimeId')
  if (!VM_EXEC_PHASES.has(phase)) {
    throw new Error(`vm.exec: invalid phase "${phase}" — must be one of suspend|resume|destroy`)
  }
  return { repoPath, command, phase: phase as VmExecParams['phase'], recipeId, runtimeId }
}

export async function handleVmExec(params: VmExecParams): Promise<{
  stdout: string
  stderr: string
  exitCode: number | null
}> {
  const context: EphemeralVmRecipeContext = {
    recipeId: params.recipeId,
    instanceId: params.runtimeId,
    repoPath: params.repoPath
    // projectId/workspaceId/workspaceName/repoUrl/branch — all optional on
    // EphemeralVmRecipeContext (ephemeral-vm-recipe-runner.ts) and not
    // available on vm.exec's params; left unset, recipe suspend/resume/
    // destroy commands do not depend on them.
  }
  const result = await runRecipeCommand({
    command: params.command,
    repoPath: params.repoPath,
    mode: params.phase,
    context
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `vm.exec (${params.phase}) exited ${result.exitCode}: ${result.stderr.slice(-2000)}`
    )
  }
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
}

// ─── vm.provision (mode 'create', streaming) ──────────────────────────────

export type VmProvisionParams = {
  repoPath: string
  command: string
  recipeId: string
  runtimeId: string
}

export function validateVmProvisionParams(params: unknown): VmProvisionParams {
  const p = (params ?? {}) as Record<string, unknown>
  return {
    repoPath: requiredStringField(p, 'repoPath'),
    command: requiredStringField(p, 'command'),
    recipeId: requiredStringField(p, 'recipeId'),
    runtimeId: requiredStringField(p, 'runtimeId')
  }
}

export function validateRuntimeIdParam(params: unknown): { runtimeId: string } {
  const p = (params ?? {}) as Record<string, unknown>
  return { runtimeId: requiredStringField(p, 'runtimeId') }
}

// runtimeId -> in-flight provision's AbortController, so vm.cancelProvision
// can cancel it. In-memory only — lost on agent restart (SOL-AG-EVM-002's
// documented tradeoff; a restart mid-provision breaks the WS stream itself,
// so the backend-go side already has to treat that as failure).
const provisionAbortRegistry = new Map<string, AbortController>()

// Recipe `create` commands can run for minutes (real cloud VM provisioning).
// No timeout exists at the StreamChannelHandler layer (backend-go side, by
// design — see BE-SOL-EVM-002) so the agent applies its own ceiling to avoid
// hanging a Dev Server indefinitely on a stuck recipe.
const DEFAULT_PROVISION_TIMEOUT_MS = 15 * 60 * 1000

// Mirrors agent-git-handler.ts's local (non-exported) sendFrame helper —
// there is no shared './protocol' module, contra SOL-AG-EVM-002's sketch.
function sendFrame(ws: WebSocket, wireState: WireState, payload: object): void {
  if (ws.readyState === 1 /* WebSocket.OPEN */) {
    ws.send(encodeDataFrame(wireState, JSON.stringify(payload)))
  }
}

export async function handleVmProvision(
  ws: WebSocket,
  wireState: WireState,
  id: string | number | null,
  params: VmProvisionParams
): Promise<void> {
  const controller = new AbortController()
  provisionAbortRegistry.set(params.runtimeId, controller)
  const timeout = setTimeout(() => controller.abort(), DEFAULT_PROVISION_TIMEOUT_MS)

  try {
    const context: EphemeralVmRecipeContext = {
      recipeId: params.recipeId,
      instanceId: params.runtimeId,
      repoPath: params.repoPath
    }
    const result = await runRecipeCommand({
      command: params.command,
      repoPath: params.repoPath,
      mode: 'create',
      context,
      signal: controller.signal,
      onStdout: (chunk) =>
        sendFrame(ws, wireState, {
          jsonrpc: '2.0',
          id,
          result: { type: 'stream.chunk', line: chunk }
        }),
      onStderr: (chunk) =>
        sendFrame(ws, wireState, {
          jsonrpc: '2.0',
          id,
          result: { type: 'stream.chunk', line: chunk, source: 'stderr' }
        })
    })

    const parsed = parseEphemeralVmRecipeResult(result.stdout)
    sendFrame(ws, wireState, {
      jsonrpc: '2.0',
      id,
      result: { type: 'stream.end', exitCode: result.exitCode, provisionResult: parsed }
    })
  } catch (error) {
    // Why: a provision failure must not throw out of this fire-and-forget
    // call (see dispatch case in agent-rpc-dispatch-misc.ts) — the dispatch
    // loop already returned its single 'stream.started' response, so the
    // only way to report a failure now is a stream.end frame carrying it.
    sendFrame(ws, wireState, {
      jsonrpc: '2.0',
      id,
      result: {
        type: 'stream.end',
        exitCode: -1,
        error: error instanceof Error ? error.message : String(error)
      }
    })
  } finally {
    clearTimeout(timeout)
    provisionAbortRegistry.delete(params.runtimeId)
  }
}

export async function handleVmCancelProvision(params: {
  runtimeId: string
}): Promise<{ cancelled: boolean }> {
  const controller = provisionAbortRegistry.get(params.runtimeId)
  if (!controller) {
    return { cancelled: false }
  }
  controller.abort()
  return { cancelled: true }
}

// ─── vm.sshDial (Hướng A: agent-outbound SSH) ──────────────────────────────

export type VmSshDialParams = {
  runtimeId: string
  target: SshDialTarget
  // From backend-go's Vault SSH secrets engine resolve, passed by value as
  // an RPC param (SOL-AG-EVM-003 "Quyết định đã chốt" mục 1) — agent never
  // fetches Vault itself. MUST NEVER be logged or written to disk.
  privateKeyPEM?: string
}

// Why this does NOT parse against EphemeralVmRecipeSshTargetSchema (as an
// earlier version of this function did): that schema is the RECIPE's own
// target shape — it requires `label` and carries display-only fields
// (`configHost`/`identitiesOnly`/`relayGracePeriodSeconds`) that only exist
// client-side, before backend-go ever resolves credentials. Backend-go's
// real vm.sshDial caller (infra-fleet-service's DialHiddenSshTarget,
// TASK-BE-EVM-014) sends a DIFFERENT, flatter shape — no `label`, and the
// resolved private key nested as `target.privateKeyPem` (not a top-level
// `privateKeyPEM` sibling). Parsing against the recipe schema rejected
// every real backend-go dial with "target.label required" — found during
// CR-EVM-005 cross-side reconciliation (2026-09-08), fixed here rather than
// on backend-go's side, since backend-go's shape carries no fabricated data
// (it genuinely has no `label` to send) and matches exactly what
// dialOutboundSshTarget (ssh-outbound-client.ts) actually reads.
export function validateVmSshDialParams(params: unknown): VmSshDialParams {
  const p = (params ?? {}) as Record<string, unknown>
  const runtimeId = requiredStringField(p, 'runtimeId')
  const t = (p.target ?? {}) as Record<string, unknown>
  const host = requiredStringField(t, 'host')
  const username = requiredStringField(t, 'username')
  const rawPort = t.port
  const port = typeof rawPort === 'number' ? rawPort : Number(rawPort)
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('vm.sshDial: invalid "target.port" param')
  }
  const identityAgent =
    typeof t.identityAgentSocket === 'string' ? t.identityAgentSocket : undefined
  const jumpHost = typeof t.jumpHost === 'string' ? t.jumpHost : undefined
  const proxyCommand = typeof t.proxyCommand === 'string' ? t.proxyCommand : undefined
  const target: SshDialTarget = { host, port, username, identityAgent, jumpHost, proxyCommand }
  // Prefer target.privateKeyPem (backend-go's real nested field); fall back
  // to a top-level privateKeyPEM sibling for forward-compat with any other
  // future caller that sends it that way.
  const nestedKey = typeof t.privateKeyPem === 'string' ? t.privateKeyPem : undefined
  const topLevelKey = typeof p.privateKeyPEM === 'string' ? p.privateKeyPEM : undefined
  const privateKeyPEM = nestedKey ?? topLevelKey
  return { runtimeId, target, privateKeyPEM }
}

// runtimeId -> live outbound SSH session ("hidden target"). In-memory only,
// same tradeoff as provisionAbortRegistry above (SOL-AG-EVM-003 "Quyết định
// đã chốt" mục 3): agent never persists this or tries to recover it after a
// restart. Every dial is a "cold"/idempotent operation by construction
// (credential arrives fresh by value each call) — backend-go is the side
// responsible for detecting a lost session via relay errors and re-issuing
// vm.sshDial; the agent has nothing to remember for that.
export const hiddenTargetRegistry = new Map<string, OutboundSshSession>()

// Why re-scrub privateKeyPEM here too, on top of ssh-outbound-client.ts's
// own scrubbing: this function is the RPC boundary — the last point before
// a thrown error's .message reaches agent-rpc-dispatch-misc.ts's
// makeError() and, from there, a log line or the wire response back to
// backend-go. Defends the security requirement even if dialOutboundSshTarget
// is mocked/bypassed (as in this file's own unit tests) or a future change
// to ssh-outbound-client.ts drops its scrubbing.
function scrubPrivateKeyFromError(err: unknown, privateKeyPEM: string | undefined): Error {
  const original = err instanceof Error ? err : new Error(String(err))
  if (!privateKeyPEM || !original.message.includes(privateKeyPEM)) {
    return original
  }
  return new Error(original.message.split(privateKeyPEM).join('[REDACTED]'))
}

export async function handleVmSshDial(
  params: VmSshDialParams
): Promise<{ hiddenTargetId: string }> {
  let session: OutboundSshSession
  try {
    session = await dialOutboundSshTarget(params.target, { privateKeyPEM: params.privateKeyPEM })
  } catch (err) {
    throw scrubPrivateKeyFromError(err, params.privateKeyPEM)
  }

  // Why overwrite instead of reject-if-exists: re-dial for an already-
  // registered runtimeId is the expected reconnect path (agent restart, or
  // backend-go's own retry after a relay error) — SOL-AG-EVM-003 mục 3.
  // Close the stale session after swapping in the new one so a hidden
  // target lookup never observes a gap.
  const previous = hiddenTargetRegistry.get(params.runtimeId)
  hiddenTargetRegistry.set(params.runtimeId, session)
  previous?.close()

  return { hiddenTargetId: params.runtimeId }
}
